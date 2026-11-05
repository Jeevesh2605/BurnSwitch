import type { Thresholds } from "../config.js";
import { CloudWatchAdapter } from "./cloudwatch.js";
import { LocalstackProbe } from "./localstackProbe.js";
import { ReplayAdapter } from "./replay.js";
import type { MetricsAdapter } from "./types.js";

/** METRICS_SOURCE = localstack-probe (default) | cloudwatch | replay (with REPLAY_FIXTURE). */
export function createAdapter(t: Thresholds): MetricsAdapter {
  const source = process.env.METRICS_SOURCE ?? "localstack-probe";
  switch (source) {
    case "localstack-probe":
      return new LocalstackProbe(t.function, t.queue, t.dlq, t.window_s);
    case "cloudwatch":
      return new CloudWatchAdapter(t.function, t.queue, t.dlq, t.window_s);
    case "replay":
      return new ReplayAdapter(
        process.env.REPLAY_FIXTURE ??
          new URL("../../fixtures/storm.json", import.meta.url).pathname,
      );
    default:
      throw new Error(`Unknown METRICS_SOURCE "${source}"`);
  }
}

export type { MetricsAdapter, Sample } from "./types.js";
