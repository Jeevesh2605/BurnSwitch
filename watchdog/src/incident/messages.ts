import type { DeployManifest, Thresholds } from "../config.js";
import { usd, type Burn } from "../cost/model.js";
import type { Sample } from "../metrics/types.js";
import type { Incident } from "./detector.js";

const x = (a: number, b: number) => (b > 0 ? `${(a / b).toFixed(1)}×` : "n/a");
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const mins = (from: string, to: string) => {
  const m = (Date.parse(to) - Date.parse(from)) / 60_000;
  return m < 1 ? `${Math.round(m * 60)}s` : `${m.toFixed(1)} min`;
};

/** The one handoff to @claude-code (send_targeted_message adds the @mention). */
export function alertText(
  inc: Incident,
  s: Sample,
  b: Burn,
  t: Thresholds,
  deploy: DeployManifest,
  oncall: string,
): string {
  return [
    `🔥 Cost incident ${inc.id}: ${t.function} is burning money in a retry storm.`,
    `• Projected burn: ${usd(b.usdPerHr)}/hr, ${x(b.usdPerHr, inc.baselineUsdPerHr)} baseline (${usd(inc.baselineUsdPerHr)}/hr)`,
    `• Invocations: ${b.invocationsPerMin.toFixed(0)}/min (${x(b.invocationsPerMin, inc.baselineInvocationsPerMin)} baseline); errors ${b.errorsPerMin.toFixed(0)}/min (${pct(b.errorRate)})`,
    `• SQS: ${s.queueInFlight} in flight on ${t.queue}, receive counts up to ${s.maxReceiveCount ?? "?"}; ${t.dlq} has ${s.dlqVisible} (${s.redriveConfigured ? "redrive on" : "no redrive policy"})`,
    `• Suspected deploy: ${deploy.deploy.commit} "${deploy.deploy.message}" (${deploy.deploy.deployed_at})`,
    ``,
    `Please reproduce and propose containment + fix per the runbook (finops-runbook.md). ` +
      `No live change without ${oncall}'s approval in this room.`,
  ].join("\n");
}

export function containedText(inc: Incident, s: Sample, b: Burn): string {
  return [
    `🧯 ${inc.id} contained: ${s.reservedConcurrency === 0 ? "order-worker reserved concurrency is 0, " : ""}invocations stopped.`,
    `• Burn ${usd(inc.peakUsdPerHr)}/hr at peak → ${usd(b.usdPerHr)}/hr now. Time to contain: ${mins(inc.openedAt, s.at)}.`,
    `• Messages kept: ${s.queueVisible + s.queueInFlight} on the queue, ${s.dlqVisible} in the DLQ. Nothing was purged.`,
  ].join("\n");
}

export function resolvedText(inc: Incident, s: Sample, b: Burn, t: Thresholds): string {
  return [
    `✅ ${inc.id} resolved: ${t.function} is processing normally (error rate ${pct(b.errorRate)}).`,
    `• Burn before → after: ${usd(inc.peakUsdPerHr)}/hr peak → ${usd(b.usdPerHr)}/hr (baseline ${usd(inc.baselineUsdPerHr)}/hr)`,
    `• Messages preserved in ${t.dlq}: ${s.dlqVisible}. Nothing was purged.`,
    `• Opened ${inc.openedAt}${inc.containedAt ? `, contained after ${mins(inc.openedAt, inc.containedAt)}` : ""}, resolved after ${mins(inc.openedAt, s.at)}.`,
  ].join("\n");
}
