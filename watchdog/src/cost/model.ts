// Projected Lambda burn in USD/hour: requests + compute (GB-seconds = memory x billed time).
// Rates come from config/pricing.json; nothing is hardcoded. Free tier is ignored.
import type { Sample } from "../metrics/types.js";

export interface Rates {
  lambda_requests_usd_per_million: number;
  lambda_gb_second_usd: number;
}

export interface Burn {
  usdPerHr: number;
  invocationsPerMin: number;
  errorsPerMin: number;
  errorRate: number; // errors / invocations, 0 when idle
  gbSecondsPerHr: number;
}

export function burnOf(s: Sample, rates: Rates): Burn {
  const perHr = 3600 / s.windowS;
  const invocationsPerHr = s.invocations * perHr;
  const gbSecondsPerHr = (s.billedMsSum / 1000) * (s.memoryMb / 1024) * perHr;
  const usdPerHr =
    (invocationsPerHr / 1_000_000) * rates.lambda_requests_usd_per_million +
    gbSecondsPerHr * rates.lambda_gb_second_usd;
  return {
    usdPerHr,
    invocationsPerMin: s.invocations * (60 / s.windowS),
    errorsPerMin: s.errors * (60 / s.windowS),
    errorRate: s.invocations > 0 ? s.errors / s.invocations : 0,
    gbSecondsPerHr,
  };
}

/** The budgeted normal burn, used until enough healthy samples exist for a live baseline. */
export function expectedBurn(
  invocationsPerMin: number,
  billedMs: number,
  memoryMb: number,
  rates: Rates,
): number {
  const perHr = invocationsPerMin * 60;
  return (
    (perHr / 1_000_000) * rates.lambda_requests_usd_per_million +
    perHr * (billedMs / 1000) * (memoryMb / 1024) * rates.lambda_gb_second_usd
  );
}

export const usd = (n: number): string =>
  n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(5)}`;
