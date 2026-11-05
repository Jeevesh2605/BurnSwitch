// @burn-watchdog: the custom Switch agent.
//   - samples order-worker every few seconds (METRICS_SOURCE adapter)
//   - prices it (config/pricing.json) and runs the detector (config/thresholds.json)
//   - on a new incident, addresses @claude-code ONCE; posts containment and resolution updates
//   - answers people who address it with the current status
//   - keeps the cost-ledger.md room document (timeline, actions, approvals, burn before/after)
import "./env.js";
import { requireEnv } from "./env.js";
import { loadDeployManifest, loadPricing, loadThresholds } from "./config.js";
import { burnOf, expectedBurn, usd, type Burn } from "./cost/model.js";
import { Detector, type DetectorEvent, type Incident } from "./incident/detector.js";
import { alertText, containedText, resolvedText } from "./incident/messages.js";
import { loadState, saveState } from "./incident/store.js";
import { noteApproval, parseApproval, track } from "./incident/timeline.js";
import { Ledger, renderLedger } from "./ledger/ledger.js";
import { log } from "./log.js";
import { createAdapter, type Sample } from "./metrics/index.js";
import { resolveBridgeUrl } from "./switch/config.js";
import { SwitchConnection } from "./switch/connection.js";
import { SwitchHttp } from "./switch/http.js";

const startedAt = Date.now();
const thresholds = loadThresholds();
const pricing = loadPricing();
const deploy = loadDeployManifest();
const HANDOFF_TO = process.env.HANDOFF_AGENT ?? "claude-code";
const ONCALL = process.env.ONCALL_NAME || "the on-call human";

const base = await resolveBridgeUrl();
const agentId = requireEnv("SWITCH_AGENT_ID");
const apiKey = requireEnv("SWITCH_AGENT_API_KEY");
const roomId = requireEnv("SWITCH_ROOM_ID");

const http = new SwitchHttp(base, agentId, apiKey);
const conn = new SwitchConnection(base, agentId, apiKey, roomId);
http.connectionId = conn.connectionId;

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
  if (!connected) return; // document ops need the connection bound to the room
  await ledger.sync(
    renderLedger(detector.state, deploy, thresholds, new Date().toISOString()),
    force,
  );
  saveState(detector.state);
}

// ---- Switch side ---------------------------------------------------------------------------

conn.on("ready", () => {
  connected = true;
  // Once per process: make sure the ledger exists and shows the current state.
  if (!ledgerChecked) {
    ledgerChecked = true;
    void syncLedger(true);
  }
});

// Approvals, as reported in the room: "Approved by <name>: <action>". Any sender but us.
const AFTER_RESOLVE_MS = 10 * 60_000;
function incidentAt(ms: number): Incident | undefined {
  const all = [
    ...(detector.state.incident ? [detector.state.incident] : []),
    ...detector.state.closed,
  ];
  return all.find(
    (i) =>
      Date.parse(i.openedAt) <= ms &&
      ms <= (i.resolvedAt ? Date.parse(i.resolvedAt) + AFTER_RESOLVE_MS : Infinity),
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
  if (p.sender_name === "burn-watchdog" || typeof p.body !== "string") return;
  const approval = parseApproval(p.body);
  if (!approval) return;
  const inc = incidentAt(p.timestamp);
  if (!inc) {
    log("info", `approval by ${approval.by} outside any incident; not recorded`);
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

async function handle(ev: DetectorEvent, s: Sample, b: Burn): Promise<void> {
  const inc = ev.incident;
  if (ev.type === "opened") {
    log("warn", `INCIDENT ${inc.id} opened at ${usd(b.usdPerHr)}/hr`);
    if (inc.handoffSent) return;
    // Loop guard: mark first and persist, so a crash or retry can never address twice.
    inc.handoffSent = true;
    saveState(detector.state);
    const text = alertText(inc, s, b, thresholds, deploy, ONCALL);
    try {
      const res = await http.op<{ event_id: string; target_statuses: Record<string, string> }>(
        "send_targeted_message",
        { body: text, target_names: [HANDOFF_TO] },
      );
      inc.alertEventId = res.event_id;
      log("info", `handed off to @${HANDOFF_TO}`, res.target_statuses);
      if (res.target_statuses[HANDOFF_TO] === "not_permitted") {
        log("warn", `@${HANDOFF_TO}'s addressing policy doesn't admit burn-watchdog`);
      }
    } catch (err) {
      log("error", `handoff failed (not retried, by design): ${(err as Error).message}`);
      await http
        .postMessage(roomId, `${text}\n\n(⚠️ couldn't address @${HANDOFF_TO} directly.)`)
        .catch(() => undefined);
    }
    return;
  }
  const text =
    ev.type === "contained" ? containedText(inc, s, b) : resolvedText(inc, s, b, thresholds);
  log("info", `INCIDENT ${inc.id} ${ev.type}`);
  await http.op("post_message", { body: text, thread_id: inc.alertEventId }).catch(async (err) => {
    log("warn", `threaded post failed (${(err as Error).message}); posting top-level`);
    await http.postMessage(roomId, text).catch((e) => log("error", (e as Error).message));
  });
}

let busy = false;
async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const s = await adapter.sample();
    const b = burnOf(s, pricing);
    last = { sample: s, burn: b };
    const events = detector.observe(s, b);
    track(detector.state.incident, events, s, b, thresholds.sample_interval_s);
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
    if (events.length && !connected) log("warn", "not connected to Switch yet; posting anyway");
    for (const ev of events) await handle(ev, s, b);
    saveState(detector.state);
    await syncLedger();
  } catch (err) {
    log("warn", `sample failed: ${(err as Error).message}`);
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

log(
  "info",
  `starting; metrics=${adapter.name}, every ${thresholds.sample_interval_s}s; bridge ${base}`,
);
conn.start();
void tick();
setInterval(() => void tick(), thresholds.sample_interval_s * 1000);
