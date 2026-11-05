// Exact count of orders the traffic generator got into SQS, for the ledger's reconciliation
// (injected = processed + visible + in flight + DLQ). Accumulates across burn:start runs and
// is reset when the scenario starts over with empty queues (scenario:up / reset --fresh).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { STATE_DIR } from "./aws.js";

export interface TrafficStats {
  since: string; // first send since the queues were (re)created
  normal: number;
  malformed: number;
  running: boolean;
  runs: { startedAt: string; stoppedAt?: string }[];
}

export const STATS_FILE = new URL("traffic-stats.json", STATE_DIR);

export function loadStats(): TrafficStats {
  if (existsSync(STATS_FILE)) {
    try {
      return JSON.parse(readFileSync(STATS_FILE, "utf8")) as TrafficStats;
    } catch {
      // fall through to a fresh record
    }
  }
  return { since: new Date().toISOString(), normal: 0, malformed: 0, running: false, runs: [] };
}

export function saveStats(s: TrafficStats): void {
  const tmp = new URL("traffic-stats.json.tmp", STATE_DIR);
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATS_FILE);
}
