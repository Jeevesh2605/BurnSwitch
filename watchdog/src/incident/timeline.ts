// Builds an incident's ledger record from what the watchdog itself observes:
//   - lifecycle events from the detector (opened, contained, resolved)
//   - infra changes between samples (concurrency, redrive, new code, partial batch failures)
//   - estimated spend while the incident is open
//   - approvals, as reported in the room (see parseApproval)
import { usd, type Burn } from "../cost/model.js";
import type { Sample } from "../metrics/types.js";
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
export function infraChanges(prev: InfraSnapshot, next: InfraSnapshot): string[] {
  const out: string[] = [];
  if (prev.reservedConcurrency !== next.reservedConcurrency) {
    out.push(
      next.reservedConcurrency === 0
        ? "Reserved concurrency set to 0 (function paused; messages stay on the queue)"
        : `Reserved concurrency ${conc(prev.reservedConcurrency)} → ${conc(next.reservedConcurrency)}`,
    );
  }
  if (prev.redriveConfigured !== next.redriveConfigured) {
    out.push(
      next.redriveConfigured
        ? "Redrive policy added: failing messages now move to the DLQ"
        : "Redrive policy removed",
    );
  }
  if (prev.codeSha && next.codeSha && prev.codeSha !== next.codeSha) {
    out.push(`New code deployed (CodeSha256 ${next.codeSha.slice(0, 12)}…)`);
  }
  if (
    prev.partialBatchResponse !== undefined &&
    next.partialBatchResponse !== undefined &&
    prev.partialBatchResponse !== next.partialBatchResponse
  ) {
    out.push(
      next.partialBatchResponse
        ? "Partial batch failure reporting enabled (ReportBatchItemFailures)"
        : "Partial batch failure reporting disabled",
    );
  }
  if (prev.mappingState && next.mappingState && prev.mappingState !== next.mappingState) {
    out.push(`Event source mapping ${prev.mappingState} → ${next.mappingState}`);
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
    }
  }

  // The open incident, or one that just resolved on this sample.
  const target = inc ?? events.find((e) => e.type === "resolved")?.incident;
  if (target && target.lastSampleAt && target.lastSampleAt !== s.at) {
    const dtS = Math.min(
      (Date.parse(s.at) - Date.parse(target.lastSampleAt)) / 1000,
      intervalS * 2,
    );
    if (dtS > 0) {
      target.spendUsd += (b.usdPerHr * dtS) / 3600;
      target.excessUsd += (Math.max(0, b.usdPerHr - target.baselineUsdPerHr) * dtS) / 3600;
    }
    target.lastSampleAt = s.at;
    const next = snapshot(s);
    for (const text of infraChanges(target.infra ?? next, next)) add(target, s.at, "action", text);
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
const APPROVAL = /approved by @?([\w.-]+)\s*[:—–-]\s*(.+)/i;

export function parseApproval(body: string): { by: string; action: string } | undefined {
  const m = APPROVAL.exec(body);
  if (!m) return undefined;
  return { by: m[1]!, action: m[2]!.split("\n")[0]!.trim().slice(0, 300) };
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
