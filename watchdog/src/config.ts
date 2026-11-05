import { readFileSync } from "node:fs";

const CONFIG_DIR = new URL("../../config/", import.meta.url);
const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, CONFIG_DIR), "utf8")) as T;

export interface Pricing {
  region: string;
  architecture: string;
  lambda_requests_usd_per_million: number | null;
  lambda_gb_second_usd: number | null;
  checked_on: string | null;
}

export interface Thresholds {
  function: string;
  queue: string;
  dlq: string;
  sample_interval_s: number;
  window_s: number;
  baseline: {
    history_min: number;
    min_samples: number;
    expected_invocations_per_min: number;
    expected_billed_ms: number;
  };
  alert: {
    burn_usd_per_hr: number | null;
    burn_multiple: number;
    min_error_rate: number;
    min_receive_count: number;
    sustain_samples: number;
  };
  recovery: { max_error_rate: number; sustain_samples: number };
  /** "Cost avoided" = (peak − baseline) × how long the storm would have run unnoticed. */
  cost?: { unnoticed_hours: number; unnoticed_assumption: string };
}

export interface DeployManifest {
  function: string;
  deploy: { commit: string; message: string; author: string; deployed_at: string };
  config: { memory_mb: number };
}

export const loadThresholds = () => readJson<Thresholds>("thresholds.json");

export function loadPricing(): Pricing & {
  lambda_requests_usd_per_million: number;
  lambda_gb_second_usd: number;
} {
  const p = readJson<Pricing>("pricing.json");
  if (p.lambda_requests_usd_per_million == null || p.lambda_gb_second_usd == null) {
    throw new Error(
      "config/pricing.json has no Lambda rates yet. Fill lambda_requests_usd_per_million and " +
        "lambda_gb_second_usd from https://aws.amazon.com/lambda/pricing/ (see its _TODO).",
    );
  }
  return p as ReturnType<typeof loadPricing>;
}

export const loadDeployManifest = (): DeployManifest =>
  JSON.parse(
    readFileSync(new URL("../../scenario/deploy-manifest.json", import.meta.url), "utf8"),
  ) as DeployManifest;
