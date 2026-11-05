// Figures shared by the ledger and the room messages, so both always say the same thing.
import type { Thresholds } from "../config.js";
import { usd } from "../cost/model.js";
import type { Incident } from "./detector.js";

export const span = (from: string, to?: string): string => {
  if (!to) return "—";
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/**
 * Alert → the recorded containment action (reserved concurrency set to 0). Not the moment
 * invocations stopped: that also happens when the burn stops for other reasons.
 */
export function timeToContain(inc: Incident): string {
  if (inc.containedBeforeAlert) return "contained before alert (paused before the incident opened)";
  if (inc.containmentActionAt) return span(inc.openedAt, inc.containmentActionAt);
  if (inc.containedAt) return "— (invocations stopped, but no containment action was recorded)";
  return "—";
}

/** (peak − baseline) × how long it would have run unnoticed. The assumption is part of it. */
export function costAvoided(inc: Incident, t: Thresholds) {
  const hours = t.cost?.unnoticed_hours ?? 8;
  const assumption = t.cost?.unnoticed_assumption ?? "until someone checks the bill";
  const usdAvoided = Math.max(0, inc.peakUsdPerHr - inc.baselineUsdPerHr) * hours;
  const money = usdAvoided >= 0.01 ? `$${usdAvoided.toFixed(2)}` : `$${usdAvoided.toFixed(4)}`;
  return {
    usd: usdAvoided,
    text:
      `${money} = (${usd(inc.peakUsdPerHr)} peak − ${usd(inc.baselineUsdPerHr)} baseline)/hr × ${hours} h, ` +
      `assuming the storm would have run unnoticed for ${hours} h (${assumption})`,
  };
}

export function burnAfter(inc: Incident): string {
  if (inc.afterUsdPerHr != null)
    return `${usd(inc.afterUsdPerHr)}/hr (measured once the backlog drained)`;
  if (inc.status === "resolved")
    return "not measured yet: waiting for the backlog to drain under live traffic";
  return "— (not resolved yet)";
}
