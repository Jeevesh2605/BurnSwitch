// Who changed the infra? The scenario's shell helpers append every successful AWS call that
// changes something to .state/change-log.jsonl, tagged with its source:
//   agent  bin/aws-local, bin/deploy-worker (what @claude-code runs; each needs an approval)
//   setup  scenario:up / reset / down and test scripts (not incident actions)
// The watchdog sees a change on a sample, finds the command that caused it here, and pairs
// agent changes with the "Approved by" lines posted in the room.
import { existsSync, readFileSync } from "node:fs";
import type { Approval, Incident, TimelineEntry } from "./detector.js";

export type ChangeCategory = "concurrency" | "redrive" | "code" | "mapping";

export interface ChangeRecord {
  at: string;
  source: "agent" | "setup";
  op: string; // e.g. "lambda put-function-concurrency"
  command: string;
  script: string;
  target?: string;
}

const FILE = new URL("../../../.state/change-log.jsonl", import.meta.url);

const OPS: Record<ChangeCategory, string[]> = {
  concurrency: ["lambda put-function-concurrency", "lambda delete-function-concurrency"],
  redrive: ["sqs set-queue-attributes"],
  code: ["lambda update-function-code", "lambda create-function"],
  mapping: ["lambda update-event-source-mapping", "lambda create-event-source-mapping"],
};

export function loadChanges(file: URL = FILE): ChangeRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ChangeRecord];
      } catch {
        return [];
      }
    });
}

const key = (r: ChangeRecord) => `${r.at} ${r.op}`;

/**
 * The command behind a change seen between two samples: the latest unused record of the
 * right kind in (from - 30 s, to + 2 s]. The slack covers clock skew and a command that
 * finished just before the previous sample was read.
 */
export function attribute(
  category: ChangeCategory,
  from: string,
  to: string,
  records: ChangeRecord[],
  used: Set<string>,
): ChangeRecord | undefined {
  const lo = Date.parse(from) - 30_000;
  const hi = Date.parse(to) + 2_000;
  const hit = records
    .filter((r) => OPS[category].includes(r.op) && !used.has(key(r)))
    .filter((r) => {
      const t = Date.parse(r.at);
      return t > lo && t <= hi;
    })
    .at(-1);
  if (hit) used.add(key(hit));
  return hit;
}

const APPROVAL_HINTS: Record<ChangeCategory, RegExp> = {
  concurrency: /concurrency/i,
  redrive: /redrive|set-queue-attributes/i,
  code: /deploy|update-function-code/i,
  mapping: /event-source-mapping|ReportBatchItemFailures|mapping/i,
};

/** The kind of an action; inferred from its text for entries recorded before attribution. */
export function categoryOf(e: TimelineEntry): ChangeCategory | undefined {
  if (e.category) return e.category;
  if (/concurrency/i.test(e.text)) return "concurrency";
  if (/redrive/i.test(e.text)) return "redrive";
  if (/new code/i.test(e.text)) return "code";
  if (/partial batch|event source mapping/i.test(e.text)) return "mapping";
  return undefined;
}

/** Recorded before change attribution existed (no source field): can't be attributed now. */
export const isLegacy = (e: TimelineEntry) => e.kind === "action" && e.source === undefined;

/**
 * Pairs each agent change with one approval of the same kind, posted from 1 min before the
 * command to 10 min after it (the "Approved by" line follows a successful command).
 * Returns the approval per timeline index; agent changes without one map to undefined.
 */
export function matchApprovals(inc: Incident): Map<number, Approval | undefined> {
  const result = new Map<number, Approval | undefined>();
  const free = [...(inc.approvals ?? [])];
  (inc.timeline ?? []).forEach((e: TimelineEntry, i) => {
    const category = categoryOf(e);
    if (e.kind !== "action" || !category || !(e.source === "agent" || isLegacy(e))) return;
    const t = Date.parse(e.changedAt ?? e.at);
    let best = -1;
    let bestGap = Infinity;
    free.forEach((a, j) => {
      const gap = Date.parse(a.at) - t;
      if (gap < -60_000 || gap > 600_000 || !APPROVAL_HINTS[category].test(a.action)) return;
      if (Math.abs(gap) < bestGap) {
        best = j;
        bestGap = Math.abs(gap);
      }
    });
    // Emulator status flips (mapping state only) never have an approval to find.
    result.set(i, best >= 0 ? free.splice(best, 1)[0] : undefined);
  });
  return result;
}

/** Counts for the ledger's "Live changes" row and the auditor. */
export function changeSummary(inc: Incident) {
  const actions = (inc.timeline ?? []).filter((e) => e.kind === "action");
  const matches = matchApprovals(inc);
  const timeline = inc.timeline ?? [];
  const approvedOf = (pred: (e: TimelineEntry) => boolean) =>
    [...matches.entries()].filter(([i, a]) => a && pred(timeline[i]!)).length;
  const agent = actions.filter((e) => e.source === "agent").length;
  const approved = approvedOf((e) => e.source === "agent");
  const legacy = actions.filter(isLegacy).length;
  return {
    agent,
    approved,
    unapproved: agent - approved,
    setup: actions.filter((e) => e.source === "setup").length,
    unattributed: actions.filter((e) => e.source === "unknown").length,
    legacy,
    legacyApproved: approvedOf(isLegacy),
  };
}
