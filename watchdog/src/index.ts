// @burn-watchdog: the custom Switch agent.
//   - samples order-worker every few seconds (METRICS_SOURCE adapter)
//   - prices it (config/pricing.json) and runs the detector (config/thresholds.json)
//   - on a new incident, addresses @claude-code ONCE; posts containment and resolution updates
//   - answers people who address it with the current status
//   - keeps the cost-ledger.md room document (timeline, actions, approvals, burn before/after)
import "./env.js";
import { requireEnv } from "./env.js";
import { realAws } from "./aws.js";
import { loadDeployManifest, loadPricing, loadThresholds } from "./config.js";
import { burnOf, expectedBurn, usd, type Burn } from "./cost/model.js";
import {
  Detector,
  type DetectorEvent,
  type Incident,
  type OutboxItem,
} from "./incident/detector.js";
import { alertText, containedText, resolvedText } from "./incident/messages.js";
import { hasState, loadState, saveState } from "./incident/store.js";
import { loadChanges } from "./incident/changes.js";
import { readTrafficStats, reconcile, reconciliationLine } from "./incident/reconcile.js";
import { noteApproval, parseApproval, track } from "./incident/timeline.js";
import { Ledger, renderLedger, restoreFromLedger } from "./ledger/ledger.js";
import { publishRunbook } from "./ledger/runbook.js";
import { log } from "./log.js";
import { createAdapter, type Sample } from "./metrics/index.js";
import { resolveBridgeUrl } from "./switch/config.js";
import { SwitchConnection } from "./switch/connection.js";
import { SwitchHttp, isTransient } from "./switch/http.js";

const startedAt = Date.now();
const thresholds = loadThresholds();
const pricing = loadPricing();
const deploy = loadDeployManifest();
const HANDOFF_TO = process.env.HANDOFF_AGENT ?? "claude-code";
const ONCALL = process.env.ONCALL_NAME || "the on-call human";
const DRY_RUN = process.env.WATCHDOG_DRY_RUN === "1";

const base = await resolveBridgeUrl();
const agentId = requireEnv("SWITCH_AGENT_ID");
const apiKey = requireEnv("SWITCH_AGENT_API_KEY");
const roomId = requireEnv("SWITCH_ROOM_ID");

const http = new SwitchHttp(base, agentId, apiKey);
http.dryRun = DRY_RUN;
const conn = new SwitchConnection(base, agentId, apiKey, roomId, resolveBridgeUrl);
http.connectionId = conn.connectionId;
conn.on("rebased", (url) => (http.baseUrl = url));

const adapter = createAdapter(thresholds);
const expected = {
  usdPerHr: expectedBurn(
    thresholds.baseline.expected_invocations_per_min,
    thresholds.baseline.expected_billed_ms,
    deploy.config.memory_mb,
    pricing,
  ),
  invocationsPerMin: thresholds.baseline.expected_invocations_per_min,
};
// No local state (first run, or .state/ was lost): wait until the ledger in the room has been
// checked, so an incident that is already open is resumed instead of alerted a second time.
let sampling = hasState();
const detector = new Detector(thresholds, expected, loadState());
if (detector.state.incident) {
  log(
    "info",
    `resuming open incident ${detector.state.incident.id} (${detector.state.incident.status})`,
  );
}

let connected = false;
let last: { sample: Sample; burn: Burn } | undefined;

const ledger = new Ledger(http, agentId, detector.state);
let ledgerChecked = false;
async function syncLedger(force = false): Promise<void> {
  // Document ops need the connection bound to the room; and never write before a restore.
  if (!connected || !sampling) return;
  await ledger.sync(
    renderLedger(detector.state, deploy, thresholds, new Date().toISOString()),
    force,
  );
  saveState(detector.state);
}

// ---- Switch side ---------------------------------------------------------------------------

async function restoreIfNeeded(): Promise<void> {
  if (sampling) return;
  try {
    const found = await restoreFromLedger(http, agentId);
    if (found) {
      Object.assign(detector.state, found.state);
      detector.state.ledger = { documentId: found.documentId };
      const inc = detector.state.incident;
      log(
        "warn",
        inc
          ? `restored from the ledger: resuming ${inc.id} (${inc.status}); no new alert`
          : `restored ${found.state.closed.length} closed incident(s) from the ledger`,
      );
      saveState(detector.state);
    }
  } catch (err) {
    log("warn", `couldn't read the ledger (${(err as Error).message}); starting empty`);
  }
  sampling = true;
}

conn.on("disconnected", () => (connected = false));

conn.on("ready", () => {
  connected = true;
  void (async () => {
    // Order matters: restore from the ledger before anything rewrites it.
    await restoreIfNeeded();
    // Once per process: publish the runbook, and create the ledger if it doesn't exist yet.
    if (!ledgerChecked) {
      ledgerChecked = true;
      await publishRunbook(http, agentId, detector.state);
    }
    await flushOutbox();
    await syncLedger();
  })();
});

// Approvals, as reported in the room: "Approved by <name>: <action>". Any sender but us.
const pendingApprovals: {
  approval: { by: string; action: string };
  sender: string;
  id: string;
  ts: number;
}[] = [];
function attachPendingApprovals(inc: Incident): void {
  const since = Date.parse(inc.openedAt) - 10 * 60_000;
  for (const a of pendingApprovals.splice(0)) {
    if (a.ts < since) continue;
    noteApproval(inc, a.approval, a.sender, a.id, new Date(a.ts).toISOString());
    log("info", `ledger: attached ${a.approval.by}'s earlier approval to ${inc.id}`);
  }
}
const AFTER_RESOLVE_MS = 30 * 60_000; // approvals for late steps (4e) still count
function incidentAt(ms: number): Incident | undefined {
  const all = [
    ...(detector.state.incident ? [detector.state.incident] : []),
    ...detector.state.closed,
  ];
  return all.find(
    (i) =>
      Date.parse(i.openedAt) <= ms &&
      ms <= (i.resolvedAt ? Date.parse(i.resolvedAt) + AFTER_RESOLVE_MS : Infinity) &&
      !(i.abandonedAt && ms > Date.parse(i.abandonedAt)),
  );
}
conn.on("event", (ev) => {
  if (ev.type !== "message") return;
  const p = ev.payload as unknown as {
    sender_name: string;
    body: string;
    message_id: string;
    timestamp: number;
  };
  // The watchdog itself and the auditor (which quotes approvals in its report) don't approve.
  if (["burn-watchdog", "finops-auditor"].includes(p.sender_name) || typeof p.body !== "string")
    return;
  const approval = parseApproval(p.body);
  if (!approval) return;
  const inc = incidentAt(p.timestamp);
  if (!inc) {
    // Kept for 10 min: if an incident opens right after (the command came before the alert),
    // it's attached to that incident instead of being lost.
    pendingApprovals.push({ approval, sender: p.sender_name, id: p.message_id, ts: p.timestamp });
    log("info", `approval by ${approval.by} before any incident; held for 10 min`);
    return;
  }
  if (
    noteApproval(inc, approval, p.sender_name, p.message_id, new Date(p.timestamp).toISOString())
  ) {
    log("info", `ledger: ${approval.by} approved "${approval.action}" (${inc.id})`);
    saveState(detector.state);
    void syncLedger();
  }
});

conn.on("addressed", async (ev) => {
  const { sender_name, body, timestamp, thread_id, message_id } = ev.payload;
  log("info", `addressed by ${sender_name}: ${body.slice(0, 200)}`);
  if (timestamp < startedAt - 60_000) return; // don't answer replays after a restart
  const inc = detector.state.incident;
  const now = last
    ? `${usd(last.burn.usdPerHr)}/hr, ${last.burn.invocationsPerMin.toFixed(0)} invocations/min, ` +
      `${(last.burn.errorRate * 100).toFixed(0)}% errors, ${last.sample.dlqVisible} in ${thresholds.dlq}`
    : "no sample yet";
  const reply = inc
    ? `burn-watchdog: ${inc.id} is ${inc.status}. Now: ${now}. Peak ${usd(inc.peakUsdPerHr)}/hr.`
    : `burn-watchdog: no open incident. ${thresholds.function} now: ${now}.`;
  await http
    .op("post_message", { body: reply, thread_id: thread_id ?? message_id })
    .catch((err) => log("error", `reply failed: ${(err as Error).message}`));
});

conn.on("stopped", (reason) => {
  log("error", `connection stopped for good: ${reason}`);
  process.exit(1);
});

// ---- Incident side -------------------------------------------------------------------------
// Room posts go through an outbox kept in the state file. If Switch is unreachable, the post
// waits and is sent on reconnect; a post that Switch refuses (e.g. @claude-code isn't in the
// room) falls back to a plain room message. Either way the alert is addressed at most once:
// handoffSent is set and saved before anything is queued.

function findIncident(id: string): Incident | undefined {
  const st = detector.state;
  return st.incident?.id === id ? st.incident : st.closed.find((i) => i.id === id);
}

async function deliver(item: OutboxItem): Promise<void> {
  const inc = findIncident(item.incidentId);
  if (item.kind === "alert") {
    try {
      const res = await http.op<{ event_id: string; target_statuses: Record<string, string> }>(
        "send_targeted_message",
        { body: item.body, target_names: [HANDOFF_TO] },
      );
      if (inc) inc.alertEventId = res.event_id;
      log("info", `handed off to @${HANDOFF_TO}`, res.target_statuses);
      if (res.target_statuses[HANDOFF_TO] === "not_permitted") {
        log("warn", `@${HANDOFF_TO}'s addressing policy doesn't admit burn-watchdog`);
      }
    } catch (err) {
      if (isTransient(err)) throw err;
      log("error", `handoff refused (not retried, by design): ${(err as Error).message}`);
      const res = await http.postMessage(
        roomId,
        `${item.body}\n\n(⚠️ couldn't address @${HANDOFF_TO} directly.)`,
      );
      if (inc) inc.alertEventId ??= res.event_id;
    }
    return;
  }
  try {
    await http.op("post_message", { body: item.body, thread_id: inc?.alertEventId });
  } catch (err) {
    if (isTransient(err)) throw err;
    log("warn", `threaded post refused (${(err as Error).message}); posting top-level`);
    await http.postMessage(roomId, item.body);
  }
}

let flushing = false;
async function flushOutbox(): Promise<void> {
  const st = detector.state;
  if (flushing || !st.outbox?.length) return;
  flushing = true;
  try {
    while (st.outbox?.length) {
      const item = st.outbox[0]!;
      try {
        await deliver(item);
      } catch (err) {
        if (isTransient(err)) {
          log("warn", `Switch unreachable; ${st.outbox.length} post(s) wait for reconnect`);
          return;
        }
        log("error", `dropping a post that can't be sent: ${(err as Error).message}`);
      }
      st.outbox.shift();
      saveState(st);
    }
  } finally {
    flushing = false;
  }
}

function enqueue(kind: OutboxItem["kind"], inc: Incident, body: string): void {
  const st = detector.state;
  (st.outbox ??= []).push({ kind, incidentId: inc.id, body, queuedAt: new Date().toISOString() });
  saveState(st);
}

function handle(ev: DetectorEvent, s: Sample, b: Burn): void {
  const inc = ev.incident;
  if (ev.type === "opened") {
    log("warn", `INCIDENT ${inc.id} opened at ${usd(b.usdPerHr)}/hr`);
    attachPendingApprovals(inc);
    if (inc.handoffSent) return;
    // Loop guard: mark first and persist, so a crash or retry can never address twice.
    inc.handoffSent = true;
    enqueue("alert", inc, alertText(inc, s, b, thresholds, deploy, ONCALL));
    return;
  }
  log("info", `INCIDENT ${inc.id} ${ev.type}`);
  enqueue(
    "update",
    inc,
    ev.type === "contained" ? containedText(inc, s, b) : resolvedText(inc, s, b, thresholds),
  );
}

// ---- Message count -----------------------------------------------------------------------
// At resolve the count is a snapshot (traffic may still run). Once the traffic generator has
// stopped and the queue has been empty for 2 samples, the final count goes in the ledger and
// as a reply under the alert.

async function countMessages(s: Sample) {
  try {
    return await reconcile(thresholds.function, s);
  } catch (err) {
    log("warn", `message count failed: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * "After" burn: only once the backlog has drained (≤ 20 queued, no errors) with traffic still
 * running, for a whole metrics window. Measured right at resolve it still includes the drain.
 */
function measureAfter(s: Sample, b: Burn): void {
  const inc = awaitingFinalCount();
  if (!inc || inc.afterUsdPerHr != null) return;
  const drained =
    readTrafficStats()?.running === true &&
    s.queueVisible + s.queueInFlight <= 20 &&
    b.errorRate === 0;
  if (!drained) {
    inc.drainedSince = undefined;
    return;
  }
  inc.drainedSince ??= s.at;
  if (Date.parse(s.at) - Date.parse(inc.drainedSince) < thresholds.window_s * 1000) return;
  inc.afterUsdPerHr = b.usdPerHr;
  inc.afterAt = s.at;
  inc.timeline.push({
    at: s.at,
    kind: "event",
    text: `After burn measured: ${usd(b.usdPerHr)}/hr (backlog drained, normal traffic)`,
  });
  log("info", `after burn for ${inc.id}: ${usd(b.usdPerHr)}/hr`);
}

/** The last closed incident, while its final count isn't in (it still records late actions). */
function awaitingFinalCount(): Incident | undefined {
  const inc = detector.state.closed.at(-1);
  if (!inc?.reconciliation || inc.reconciliation.final || !inc.resolvedAt) return undefined;
  return Date.now() - Date.parse(inc.resolvedAt) < 3_600_000 ? inc : undefined;
}

async function finalCount(s: Sample): Promise<void> {
  const inc = detector.state.closed.at(-1);
  if (!inc?.reconciliation || inc.reconciliation.final || !inc.resolvedAt) return;
  if (Date.now() - Date.parse(inc.resolvedAt) > 3_600_000) return; // gave up after an hour
  const idle = !readTrafficStats()?.running && s.queueVisible === 0 && s.queueInFlight === 0;
  inc.reconcileIdle = idle ? (inc.reconcileIdle ?? 0) + 1 : 0;
  if (inc.reconcileIdle < 2) return;
  const r = await countMessages(s);
  if (!r?.final) return;
  inc.reconciliation = r;
  const line = reconciliationLine(r);
  inc.timeline.push({
    at: s.at,
    kind: "event",
    text: `Final count: ${line.replace(/^• Count: /, "")}`,
  });
  log("info", `final count for ${inc.id}: ${line}`);
  enqueue(
    "update",
    inc,
    [`📊 ${inc.id} final count`, line, ...r.notes.map((n) => `• ${n}`)].join("\n"),
  );
}

let busy = false;
let awsDownSince: number | undefined;
async function tick(): Promise<void> {
  if (busy || !sampling) return;
  busy = true;
  try {
    const s = await adapter.sample();
    if (awsDownSince) {
      log("info", `AWS endpoint is back after ${Math.round((Date.now() - awsDownSince) / 1000)}s`);
      awsDownSince = undefined;
    }
    const b = burnOf(s, pricing);
    last = { sample: s, burn: b };
    const events = detector.observe(s, b);
    track(
      detector.state.incident ?? awaitingFinalCount(),
      events,
      s,
      b,
      thresholds.sample_interval_s,
      loadChanges(),
    );
    const resolved = events.find((e) => e.type === "resolved")?.incident;
    if (resolved) resolved.reconciliation = await countMessages(s);
    saveState(detector.state);
    const inc = detector.state.incident;
    log(
      "info",
      `${usd(b.usdPerHr)}/hr | ${b.invocationsPerMin.toFixed(0)} inv/min | ` +
        `${(b.errorRate * 100).toFixed(0)}% err | rc ${s.maxReceiveCount ?? "?"} | ` +
        `in-flight ${s.queueInFlight} | dlq ${s.dlqVisible}` +
        (inc
          ? ` | ${inc.id} ${inc.status}`
          : ` | baseline ${usd(detector.baseline(Date.now()).usdPerHr)}/hr`),
    );
    for (const ev of events) handle(ev, s, b);
    measureAfter(s, b);
    await finalCount(s);
    if (connected) await flushOutbox();
    else if (detector.state.outbox?.length) log("warn", "not connected to Switch; posts queued");
    saveState(detector.state);
    await syncLedger();
  } catch (err) {
    // LocalStack restarting, or the network: skip this sample, and say so once per outage.
    if (!awsDownSince) {
      awsDownSince = Date.now();
      log("warn", `can't sample AWS (${(err as Error).message}); retrying every interval`);
    }
  } finally {
    busy = false;
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    saveState(detector.state);
    conn.stop(sig);
    process.exit(0);
  });
}

if (realAws) {
  log(
    "warn",
    `⚠️  REAL AWS: watching ${thresholds.function} in ${process.env.AWS_REGION ?? "us-east-1"}`,
  );
}
const region = process.env.AWS_REGION ?? "us-east-1";
if (pricing.region !== region) {
  log(
    "warn",
    `prices in config/pricing.json are for ${pricing.region}, but AWS_REGION is ${region}`,
  );
}
log(
  "info",
  `starting; metrics=${adapter.name}, every ${thresholds.sample_interval_s}s; bridge ${base}` +
    (DRY_RUN ? " (DRY RUN: nothing is posted)" : ""),
);
conn.start();
if (!sampling) {
  log("info", "no local state: waiting for Switch to check the ledger before sampling");
  setTimeout(() => {
    if (!sampling) {
      log("warn", "couldn't check the ledger in 30s; starting with empty state");
      sampling = true;
    }
  }, 30_000);
}
void tick();
setInterval(() => void tick(), thresholds.sample_interval_s * 1000);
