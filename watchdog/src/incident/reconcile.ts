// Message reconciliation: every order the traffic generator got into SQS must be somewhere.
//
//   injected = processed + visible + in flight + DLQ
//
//   injected   .state/traffic-stats.json (exact; written by the traffic generator)
//   processed  distinct orderIds priced in an invocation that didn't fail (Lambda logs).
//              With the old code a failed batch logs "order priced" for orders that are then
//              retried, so those invocations are left out.
//   visible, in flight, DLQ  SQS counts from the same sample
//
// Malformed orders can never be priced, so once the queue is empty the DLQ splits exactly:
//   good orders in the DLQ = normal injected − processed;  the rest are malformed.
import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { existsSync, readFileSync } from "node:fs";
import { aws } from "../aws.js";
import type { Sample } from "../metrics/types.js";

export interface Reconciliation {
  at: string;
  final: boolean; // traffic stopped and the queue empty: nothing can move any more
  injected?: { normal: number; malformed: number; total: number };
  processed: number;
  visible: number;
  inFlight: number;
  dlq: number;
  difference?: number; // injected − (processed + visible + in flight + DLQ)
  goodInDlq?: number;
  malformedInDlq?: number;
  notes: string[];
}

interface TrafficStats {
  since: string;
  normal: number;
  malformed: number;
  running: boolean;
}

const STATS = new URL("../../../.state/traffic-stats.json", import.meta.url);

export function readTrafficStats(file: URL = STATS): TrafficStats | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TrafficStats;
  } catch {
    return undefined;
  }
}

/** Distinct orders priced in invocations that completed (no error, no timeout). */
export function countProcessed(lines: string[]): number {
  const failed = new Set<string>();
  const priced = new Map<string, string[]>();
  for (const line of lines) {
    const [, req, level, rest] = line.split("\t");
    // A failed invocation is "Invoke Error". Other ERROR lines are the handler's own logs
    // (the patched worker logs each rejected order at error level; the invocation succeeds).
    if (req && level === "ERROR" && rest?.startsWith("Invoke Error")) failed.add(req);
    const timeout = /RequestId: (\S+).*(Status: timeout|timed out)/i.exec(line);
    if (timeout) failed.add(timeout[1]!);
    const m = /"msg":"order priced","orderId":"([^"]+)"/.exec(line);
    if (req && m) priced.set(req, [...(priced.get(req) ?? []), m[1]!]);
  }
  const ok = new Set<string>();
  for (const [req, ids] of priced) if (!failed.has(req)) ids.forEach((id) => ok.add(id));
  return ok.size;
}

async function readLines(fn: string, sinceMs: number): Promise<string[]> {
  const lines: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await aws.logs.send(
      new FilterLogEventsCommand({
        logGroupName: `/aws/lambda/${fn}`,
        startTime: sinceMs,
        endTime: Date.now(),
        nextToken,
      }),
    );
    for (const e of res.events ?? []) if (e.message) lines.push(e.message);
    nextToken = res.nextToken;
  } while (nextToken);
  return lines;
}

/** Pure part, so it can be tested without AWS. */
export function buildReconciliation(
  s: Sample,
  stats: TrafficStats | undefined,
  processed: number,
): Reconciliation {
  const r: Reconciliation = {
    at: s.at,
    final: false,
    processed,
    visible: s.queueVisible,
    inFlight: s.queueInFlight,
    dlq: s.dlqVisible,
    notes: [],
  };
  if (!stats) {
    r.notes.push(
      "No traffic stats (.state/traffic-stats.json): orders weren't sent by burn:start.",
    );
    return r;
  }
  const total = stats.normal + stats.malformed;
  r.injected = { normal: stats.normal, malformed: stats.malformed, total };
  r.difference = total - (processed + r.visible + r.inFlight + r.dlq);
  const queueEmpty = r.visible === 0 && r.inFlight === 0;
  r.final = !stats.running && queueEmpty;

  if (queueEmpty) {
    r.goodInDlq = Math.max(0, stats.normal - processed);
    r.malformedInDlq = r.dlq - r.goodInDlq;
  }
  if (stats.running) r.notes.push("Traffic still running: counts are a snapshot.");
  if (r.inFlight > 0) r.notes.push(`${r.inFlight} message(s) in flight, still being processed.`);
  if (r.difference !== 0) {
    const what =
      r.difference > 0
        ? `${r.difference} order(s) sent but not yet seen as processed, queued or in the DLQ`
        : `${-r.difference} more order(s) counted than were sent (orders not from burn:start?)`;
    r.notes.push(
      r.final
        ? `Unexplained: ${what}.`
        : `${what}: expected while processing continues (log lines and SQS counts lag a few seconds).`,
    );
  }
  if (r.goodInDlq !== undefined && r.goodInDlq > 0) {
    r.notes.push(`${r.goodInDlq} good order(s) are in the DLQ: valid orders were dead-lettered.`);
  }
  if (r.malformedInDlq !== undefined && r.goodInDlq === 0) {
    r.notes.push(
      r.malformedInDlq === stats.malformed
        ? `The DLQ holds exactly the ${stats.malformed} malformed order(s), nothing else.`
        : `The DLQ holds ${r.malformedInDlq} malformed order(s) of ${stats.malformed} sent.`,
    );
  }
  return r;
}

/** Good orders sent but not processed yet: 0 (or just the newest traffic) once drained. */
export async function outstandingGood(fn: string) {
  const stats = readTrafficStats();
  if (!stats) return undefined;
  const processed = countProcessed(await readLines(fn, Date.parse(stats.since) - 5_000));
  return {
    normal: stats.normal,
    processed,
    outstanding: stats.normal - processed,
    running: stats.running,
  };
}

export async function reconcile(fn: string, s: Sample): Promise<Reconciliation> {
  const stats = readTrafficStats();
  const since = stats ? Date.parse(stats.since) - 5_000 : Date.now() - 3_600_000;
  const processed = countProcessed(await readLines(fn, since));
  return buildReconciliation(s, stats, processed);
}

/** One line for room messages. */
export function reconciliationLine(r: Reconciliation): string {
  if (!r.injected) return `• Count: ${r.notes[0] ?? "no data"}`;
  const ok = r.difference === 0 ? "✓" : `≠ (difference ${r.difference})`;
  const dlq =
    r.goodInDlq !== undefined
      ? `${r.dlq} in DLQ (${r.malformedInDlq} malformed, ${r.goodInDlq} good)`
      : `${r.dlq} in DLQ`;
  return (
    `• Count: ${r.injected.total} sent (${r.injected.normal} normal + ${r.injected.malformed} malformed) ` +
    `= ${r.processed} processed + ${r.visible + r.inFlight} on the queue + ${dlq} ${ok}`
  );
}
