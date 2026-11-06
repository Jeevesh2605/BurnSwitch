// Builds an incident's ledger record from what the watchdog itself observes:
//   - lifecycle events from the detector (opened, contained, resolved)
//   - infra changes between samples (concurrency, redrive, new code, partial batch failures)
//   - estimated spend while the incident is open
//   - approvals, as reported in the room (see parseApproval)
import { usd, type Burn } from "../cost/model.js";
import type { Sample } from "../metrics/types.js";
import { attribute, LOGGED_ONLY, type ChangeCategory, type ChangeRecord } from "./changes.js";
import type { DetectorEvent, Incident, InfraSnapshot, TimelineEntry } from "./detector.js";

const snapshot = (s: Sample): InfraSnapshot => ({
  reservedConcurrency: s.reservedConcurrency,
  redriveConfigured: s.redriveConfigured,
  codeSha: s.codeSha,
  mappingState: s.mappingState,
  partialBatchResponse: s.partialBatchResponse,
});

const conc = (n: number | null) => (n == null ? "unreserved" : String(n));

/** Plain-language descriptions of what changed. Values a source can't see are skipped. */
export function infraChanges(
  prev: InfraSnapshot,
  next: InfraSnapshot,
): { category: ChangeCategory; text: string }[] {
  const out: { category: ChangeCategory; text: string }[] = [];
  const push = (category: ChangeCategory, text: string) => out.push({ category, text });
  if (prev.reservedConcurrency !== next.reservedConcurrency) {
    push(
      "concurrency",
      next.reservedConcurrency === 0
        ? "Reserved concurrency set to 0 (function paused; messages stay on the queue)"
        : `Reserved concurrency ${conc(prev.reservedConcurrency)} → ${conc(next.reservedConcurrency)}`,
    );
  }
  if (prev.redriveConfigured !== next.redriveConfigured) {
    push(
      "redrive",
      next.redriveConfigured
        ? "Redrive policy added: failing messages now move to the DLQ"
        : "Redrive policy removed",
    );
  }
  if (prev.codeSha && next.codeSha && prev.codeSha !== next.codeSha) {
    push("code", `New code deployed (CodeSha256 ${next.codeSha.slice(0, 12)}…)`);
  }
  if (
    prev.partialBatchResponse !== undefined &&
    next.partialBatchResponse !== undefined &&
    prev.partialBatchResponse !== next.partialBatchResponse
  ) {
    push(
      "mapping",
      next.partialBatchResponse
        ? "Partial batch failure reporting enabled (ReportBatchItemFailures)"
        : "Partial batch failure reporting disabled",
    );
  }
  if (prev.mappingState && next.mappingState && prev.mappingState !== next.mappingState) {
    push("mapping", `Event source mapping ${prev.mappingState} → ${next.mappingState}`);
  }
  return out;
}

const add = (inc: Incident, at: string, kind: TimelineEntry["kind"], text: string) =>
  inc.timeline.push({ at, kind, text });

/**
 * Updates the incident that `events` or the detector state refer to. Call after every
 * observe(). `intervalS` caps how much time one sample can account for (after a pause or
 * restart, the gap isn't billed as if the last burn rate held the whole time).
 */
export function track(
  inc: Incident | undefined,
  events: DetectorEvent[],
  s: Sample,
  b: Burn,
  intervalS: number,
  changes: ChangeRecord[] = [],
): void {
  for (const ev of events) {
    const i = ev.incident;
    i.timeline ??= [];
    i.approvals ??= [];
    i.spendUsd ??= 0;
    i.excessUsd ??= 0;
    if (ev.type === "opened") {
      add(
        i,
        s.at,
        "event",
        `Incident opened at ${usd(b.usdPerHr)}/hr (baseline ${usd(i.baselineUsdPerHr)}/hr); ` +
          `${(b.errorRate * 100).toFixed(0)}% errors, receive counts up to ${s.maxReceiveCount ?? "?"}`,
      );
      i.infra = snapshot(s);
      i.lastSampleAt = s.at;
      // Already paused when the incident opened (e.g. an approval meant for an earlier
      // incident): record that action here, and don't credit it as a time to contain.
      if (s.reservedConcurrency === 0) {
        const used = new Set(i.usedChanges ?? []);
        const from = new Date(Date.parse(s.at) - 10 * 60_000).toISOString();
        const rec = attribute("concurrency", from, s.at, changes, used);
        i.timeline.push({
          at: s.at,
          kind: "action",
          text: "Reserved concurrency was already 0 when this incident opened (paused before the alert)",
          category: "concurrency",
          source: rec?.source ?? "unknown",
          command: rec?.command,
          changedAt: rec?.at,
        });
        i.usedChanges = [...used];
        i.containmentActionAt = rec?.at ?? s.at;
        i.containedBeforeAlert = true;
      }
    }
  }

  // The open incident, or one that just resolved, or (passed in by the caller) the last
  // closed one whose final message count isn't in yet.
  const target = inc ?? events.find((e) => e.type === "resolved")?.incident;
  if (target && target.lastSampleAt && target.lastSampleAt !== s.at) {
    const dtS = Math.min(
      (Date.parse(s.at) - Date.parse(target.lastSampleAt)) / 1000,
      intervalS * 2,
    );
    // A resolved incident still gets its late actions (e.g. the redrive policy, which comes
    // last), but no more spend.
    const accrue =
      target.status !== "resolved" ||
      events.some((e) => e.type === "resolved" && e.incident === target);
    if (dtS > 0 && accrue) {
      target.spendUsd += (b.usdPerHr * dtS) / 3600;
      target.excessUsd += (Math.max(0, b.usdPerHr - target.baselineUsdPerHr) * dtS) / 3600;
    }
    const from = target.lastSampleAt;
    target.lastSampleAt = s.at;
    const next = snapshot(s);
    const used = new Set(target.usedChanges ?? []);
    for (const c of infraChanges(target.infra ?? next, next)) {
      const rec = attribute(c.category, from, s.at, changes, used);
      if (c.category === "concurrency" && next.reservedConcurrency === 0) {
        target.containmentActionAt ??= rec?.at ?? s.at;
      }
      target.timeline.push({
        at: s.at,
        kind: "action",
        text: c.text,
        category: c.category,
        source: rec?.source ?? "unknown",
        command: rec?.command,
        changedAt: rec?.at,
      });
    }
    // A DLQ move doesn't show in the infra a sample reads: take it from the change log.
    for (const category of LOGGED_ONLY) {
      let rec: ChangeRecord | undefined;
      while ((rec = attribute(category, from, s.at, changes, used))) {
        target.timeline.push({
          at: s.at,
          kind: "action",
          text: "Messages moved from the DLQ back to the queue (start-message-move-task)",
          category,
          source: rec.source,
          command: rec.command,
          changedAt: rec.at,
        });
      }
    }
    // A sample can see a change before the helper has written its log line (it writes after
    // the command returns): retry unattributed changes for 2 min.
    for (const e of target.timeline) {
      if (e.kind !== "action" || e.source !== "unknown" || !e.category || e.command) continue;
      if (Date.parse(s.at) - Date.parse(e.at) > 120_000) continue;
      const rec = attribute(e.category, e.at, e.at, changes, used);
      if (!rec) continue;
      if (target.containmentActionAt === e.at && e.category === "concurrency") {
        target.containmentActionAt = rec.at;
      }
      Object.assign(e, { source: rec.source, command: rec.command, changedAt: rec.at });
    }
    target.usedChanges = [...used];
    target.infra = next;
  }

  for (const ev of events) {
    if (ev.type === "contained") {
      add(ev.incident, s.at, "event", "Contained: no invocations, the burn has stopped");
    } else if (ev.type === "resolved") {
      add(
        ev.incident,
        s.at,
        "event",
        `Resolved: processing normally at ${usd(b.usdPerHr)}/hr, ` +
          `${(b.errorRate * 100).toFixed(1)}% errors; ${s.dlqVisible} message(s) kept in the DLQ`,
      );
    }
  }
}

/**
 * Approvals are reported in the room by the agent that ran the change, as
 *   "Approved by <name>: <action>"
 * (room instructions ask @claude-code to post this). Switch records who tapped Allow
 * (answered_by), but no agent operation returns it, so this line is the only source.
 */
// Only a line that starts with "Approved by" (after an emoji or bullet) counts, so a summary
// that mentions approvals, like a post-mortem, isn't mistaken for one.
const APPROVAL = /^[^\p{L}\p{N}@]*approved by @?([\w.-]+)\s*[:—–-]\s*(.+)/imu;

export function parseApproval(body: string): { by: string; action: string } | undefined {
  const m = APPROVAL.exec(body);
  if (!m) return undefined;
  return { by: m[1]!, action: m[2]!.split("\n")[0]!.trim().slice(0, 300) };
}

/**
 * The on-call human asking @claude-code to run something, e.g. "@claude-code run 4c".
 * Its permission prompt follows, so this is the request the change is paired with.
 */
export function parseRequest(body: string): string | undefined {
  const line = body.split("\n").find((l) => /\brun\b/i.test(l));
  return line?.trim().slice(0, 200);
}

/** Records a request on the incident. Returns false if this message was already recorded. */
export function noteRequest(
  inc: Incident,
  by: string,
  text: string,
  messageId: string,
  at: string,
): boolean {
  inc.requests ??= [];
  inc.timeline ??= [];
  if (inc.requests.some((r) => r.messageId === messageId)) return false;
  inc.requests.push({ at, by, text, messageId });
  add(inc, at, "request", `${by} asked: "${text}"`);
  return true;
}

/** Records an approval on the incident. Returns false if this message was already recorded. */
export function noteApproval(
  inc: Incident,
  a: { by: string; action: string },
  reportedBy: string,
  messageId: string,
  at: string,
): boolean {
  inc.approvals ??= [];
  inc.timeline ??= [];
  if (inc.approvals.some((x) => x.messageId === messageId)) return false;
  inc.approvals.push({ at, by: a.by, action: a.action, reportedBy, messageId });
  add(inc, at, "approval", `${a.by} approved: ${a.action} (reported by @${reportedBy})`);
  return true;
}
