// Turns samples into incident lifecycle events. Pure and serializable, so the watchdog can
// persist it and resume after a restart without alerting twice.
//
//   healthy --(breach for N samples)--> burning --(no invocations for N)--> contained
//      ^                                    \                                  |
//      +------------- resolved <------------(processing, low errors for N)----+
import type { Thresholds } from "../config.js";
import type { Burn } from "../cost/model.js";
import type { Sample } from "../metrics/types.js";

export type Status = "burning" | "contained" | "resolved";

export interface Incident {
  id: string;
  status: Status;
  openedAt: string;
  baselineUsdPerHr: number;
  baselineInvocationsPerMin: number;
  peakUsdPerHr: number;
  peakInvocationsPerMin: number;
  peakErrorRate: number;
  peakReceiveCount: number | null;
  firstSample: Sample;
  firstBurn: Burn;
  containedAt?: string;
  resolvedAt?: string;
  finalUsdPerHr?: number;
  dlqAtResolve?: number;
  handoffSent: boolean; // loop guard: @claude-code is addressed at most once per incident
  alertEventId?: string;
}

export interface DetectorState {
  healthy: { at: string; usdPerHr: number; invocationsPerMin: number }[];
  breachStreak: number;
  containStreak: number;
  recoverStreak: number;
  incident?: Incident;
  closed: Incident[];
}

export type DetectorEvent =
  | { type: "opened"; incident: Incident }
  | { type: "contained"; incident: Incident }
  | { type: "resolved"; incident: Incident };

export const emptyState = (): DetectorState => ({
  healthy: [],
  breachStreak: 0,
  containStreak: 0,
  recoverStreak: 0,
  closed: [],
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function newIncidentId(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}`;
  return `INC-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

export class Detector {
  constructor(
    private readonly t: Thresholds,
    private readonly expected: { usdPerHr: number; invocationsPerMin: number },
    public state: DetectorState = emptyState(),
  ) {}

  baseline(now: number): { usdPerHr: number; invocationsPerMin: number; live: boolean } {
    const since = now - this.t.baseline.history_min * 60_000;
    const recent = this.state.healthy.filter((h) => Date.parse(h.at) >= since);
    if (recent.length < this.t.baseline.min_samples) return { ...this.expected, live: false };
    return {
      usdPerHr: median(recent.map((h) => h.usdPerHr)),
      invocationsPerMin: median(recent.map((h) => h.invocationsPerMin)),
      live: true,
    };
  }

  observe(s: Sample, b: Burn): DetectorEvent[] {
    const st = this.state;
    const now = Date.parse(s.at);
    const events: DetectorEvent[] = [];
    const healthy = b.invocationsPerMin > 0 && b.errorRate <= this.t.recovery.max_error_rate;

    if (!st.incident) {
      const base = this.baseline(now);
      const a = this.t.alert;
      const overBurn =
        (a.burn_usd_per_hr != null && b.usdPerHr >= a.burn_usd_per_hr) ||
        b.usdPerHr >= a.burn_multiple * base.usdPerHr;
      const retrying = s.maxReceiveCount == null || s.maxReceiveCount >= a.min_receive_count;
      const breach = overBurn && b.errorRate >= a.min_error_rate && retrying;

      st.breachStreak = breach ? st.breachStreak + 1 : 0;
      if (healthy && !breach) {
        st.healthy.push({ at: s.at, usdPerHr: b.usdPerHr, invocationsPerMin: b.invocationsPerMin });
        const keep = now - this.t.baseline.history_min * 60_000;
        st.healthy = st.healthy.filter((h) => Date.parse(h.at) >= keep);
      }
      if (st.breachStreak >= a.sustain_samples) {
        st.incident = {
          id: newIncidentId(new Date(now)),
          status: "burning",
          openedAt: s.at,
          baselineUsdPerHr: base.usdPerHr,
          baselineInvocationsPerMin: base.invocationsPerMin,
          peakUsdPerHr: b.usdPerHr,
          peakInvocationsPerMin: b.invocationsPerMin,
          peakErrorRate: b.errorRate,
          peakReceiveCount: s.maxReceiveCount,
          firstSample: s,
          firstBurn: b,
          handoffSent: false,
        };
        st.breachStreak = 0;
        events.push({ type: "opened", incident: st.incident });
      }
      return events;
    }

    const inc = st.incident;
    inc.peakUsdPerHr = Math.max(inc.peakUsdPerHr, b.usdPerHr);
    inc.peakInvocationsPerMin = Math.max(inc.peakInvocationsPerMin, b.invocationsPerMin);
    inc.peakErrorRate = Math.max(inc.peakErrorRate, b.errorRate);
    if (s.maxReceiveCount != null) {
      inc.peakReceiveCount = Math.max(inc.peakReceiveCount ?? 0, s.maxReceiveCount);
    }

    const idle = b.invocationsPerMin === 0 || s.reservedConcurrency === 0;
    st.containStreak = inc.status === "burning" && idle ? st.containStreak + 1 : 0;
    st.recoverStreak = healthy && s.reservedConcurrency !== 0 ? st.recoverStreak + 1 : 0;

    if (st.containStreak >= this.t.recovery.sustain_samples) {
      inc.status = "contained";
      inc.containedAt = s.at;
      st.containStreak = 0;
      events.push({ type: "contained", incident: inc });
    }
    if (st.recoverStreak >= this.t.recovery.sustain_samples) {
      inc.status = "resolved";
      inc.resolvedAt = s.at;
      inc.finalUsdPerHr = b.usdPerHr;
      inc.dlqAtResolve = s.dlqVisible;
      st.recoverStreak = 0;
      st.closed.push(inc);
      st.incident = undefined;
      events.push({ type: "resolved", incident: inc });
    }
    return events;
  }
}
