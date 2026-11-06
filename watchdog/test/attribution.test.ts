import { test } from "node:test";
import assert from "node:assert/strict";
import type { Thresholds } from "../src/config.js";
import { burnOf } from "../src/cost/model.js";
import {
  changeSummary,
  matchApprovals,
  matchRequests,
  requestKind,
  type ChangeRecord,
} from "../src/incident/changes.js";
import { Detector } from "../src/incident/detector.js";
import { buildReconciliation, countProcessed } from "../src/incident/reconcile.js";
import {
  noteApproval,
  noteRequest,
  parseApproval,
  parseRequest,
  track,
} from "../src/incident/timeline.js";
import { costAvoided, timeToContain } from "../src/incident/summary.js";
import type { Sample } from "../src/metrics/types.js";

const rates = { lambda_requests_usd_per_million: 1, lambda_gb_second_usd: 0.001 };
const t = {
  function: "order-worker",
  queue: "orders",
  dlq: "orders-dlq",
  sample_interval_s: 15,
  window_s: 60,
  baseline: {
    history_min: 10,
    min_samples: 2,
    expected_invocations_per_min: 120,
    expected_billed_ms: 130,
  },
  alert: {
    burn_usd_per_hr: null,
    burn_multiple: 1.5,
    min_error_rate: 0.05,
    min_receive_count: 3,
    sustain_samples: 2,
  },
  recovery: { max_error_rate: 0.01, sustain_samples: 2 },
} as Thresholds;

let clock = Date.parse("2026-11-06T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const sample = (over: Partial<Sample>): Sample => {
  clock += 15_000;
  return {
    at: iso(clock),
    windowS: 60,
    invocations: 240,
    errors: 200,
    billedMsSum: 240 * 600,
    memoryMb: 512,
    maxReceiveCount: 12,
    queueVisible: 0,
    queueInFlight: 50,
    dlqVisible: 0,
    redriveConfigured: false,
    reservedConcurrency: null,
    mappingState: "Enabled",
    partialBatchResponse: false,
    ...over,
  };
};

test("each change is attributed to its command; agent changes pair with approvals", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  const step = (s: Sample, changes: ChangeRecord[] = []) => {
    const ev = d.observe(s, burnOf(s, rates));
    track(d.state.incident, ev, s, burnOf(s, rates), 15, changes);
  };
  step(sample({}));
  step(sample({}));
  const inc = d.state.incident!;
  const changes: ChangeRecord[] = [
    {
      at: iso(clock + 5_000),
      source: "agent",
      op: "lambda put-function-concurrency",
      command:
        "lambda put-function-concurrency --function-name order-worker --reserved-concurrent-executions 0",
      script: "aws-local",
    },
    {
      at: iso(clock + 20_000),
      source: "setup",
      op: "sqs set-queue-attributes",
      command: "sqs set-queue-attributes ...",
      script: "reset.sh",
    },
  ];
  step(sample({ reservedConcurrency: 0 }), changes);
  noteApproval(
    inc,
    { by: "jeevesh2605", action: "put-function-concurrency order-worker 0" },
    "claude-code",
    "m1",
    iso(clock + 3_000),
  );
  step(sample({ reservedConcurrency: 0, redriveConfigured: true }), changes);
  step(
    sample({ reservedConcurrency: 0, redriveConfigured: true, mappingState: "Disabled" }),
    changes,
  );

  const actions = inc.timeline.filter((e) => e.kind === "action");
  assert.deepEqual(
    actions.map((e) => e.source),
    ["agent", "setup", "unknown"],
  );
  const m = matchApprovals(inc);
  assert.equal([...m.values()][0]?.by, "jeevesh2605");
  assert.deepEqual(changeSummary(inc), {
    agent: 1,
    approved: 1,
    unapproved: 0,
    setup: 1,
    unattributed: 1,
    legacy: 0,
    legacyApproved: 0,
  });
});

test("processed = orders priced in invocations that completed", () => {
  const lines = [
    '2026\treq-ok\tINFO\t{"msg":"order priced","orderId":"ord-1","total":1}',
    '2026\treq-ok\tINFO\t{"msg":"order priced","orderId":"ord-2","total":1}',
    '2026\treq-bad\tINFO\t{"msg":"order priced","orderId":"ord-3","total":1}',
    "2026\treq-bad\tERROR\tInvoke Error {}",
    '2026\treq-ok2\tINFO\t{"msg":"order priced","orderId":"ord-3","total":1}',
    '2026\treq-ok2\tINFO\t{"msg":"order priced","orderId":"ord-1","total":1}',
  ];
  assert.equal(countProcessed(lines), 3); // ord-3 counts once its retry succeeded; ord-1 once
  // The patched worker logs a rejected order at ERROR level; that invocation still succeeded.
  const patched = [
    '2026\treq-p\tINFO\t{"msg":"order priced","orderId":"ord-9","total":1}',
    '2026\treq-p\tERROR\t{"msg":"invalid order","messageId":"m-1","error":"missing or empty items"}',
  ];
  assert.equal(countProcessed(patched), 1);
});

test("reconciliation adds up, and splits the DLQ once the queue is empty", () => {
  const s = sample({ queueVisible: 0, queueInFlight: 0, dlqVisible: 30 });
  const stats = { since: s.at, normal: 170, malformed: 30, running: false };
  const r = buildReconciliation(s, stats, 170);
  assert.equal(r.difference, 0);
  assert.equal(r.final, true);
  assert.equal(r.goodInDlq, 0);
  assert.equal(r.malformedInDlq, 30);
  assert.match(r.notes.join(" "), /exactly the 30 malformed/);

  const bad = buildReconciliation(s, { ...stats, normal: 180 }, 170);
  assert.equal(bad.difference, 10);
  assert.match(bad.notes.join(" "), /Unexplained: 10 order/);

  const live = buildReconciliation(
    sample({ queueInFlight: 10, dlqVisible: 0 }),
    { ...stats, running: true },
    0,
  );
  assert.equal(live.final, false);
  assert.match(live.notes.join(" "), /10 message\(s\) in flight/);
});

test("only a line that starts with 'Approved by' is an approval", () => {
  assert.deepEqual(parseApproval("Approved by jeevesh2605: put-function-concurrency 0"), {
    by: "jeevesh2605",
    action: "put-function-concurrency 0",
  });
  assert.equal(parseApproval("✅ Approved by jeevesh2605: deploy")?.by, "jeevesh2605");
  // A post-mortem quoting approvals is not one.
  assert.equal(
    parseApproval("Who approved what: 6 changes, all approved by you: pause (06:55)"),
    undefined,
  );
});

test("actions recorded before attribution still pair with their approval lines", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  const s1 = sample({});
  d.observe(s1, burnOf(s1, rates));
  const s2 = sample({});
  const [ev] = d.observe(s2, burnOf(s2, rates));
  const inc = ev!.incident;
  inc.timeline = [
    { at: iso(clock), kind: "action", text: "Reserved concurrency set to 0 (function paused)" },
  ];
  noteApproval(
    inc,
    { by: "jeevesh2605", action: "put-function-concurrency 0" },
    "claude-code",
    "m9",
    iso(clock - 2_000),
  );
  const sum = changeSummary(inc);
  assert.equal(sum.legacy, 1);
  assert.equal(sum.legacyApproved, 1);
});

test("a pause made before the alert: recorded, and not credited as a time to contain", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  const changes: ChangeRecord[] = [
    {
      at: iso(clock + 1_000),
      source: "agent",
      op: "lambda put-function-concurrency",
      command:
        "lambda put-function-concurrency --function-name order-worker --reserved-concurrent-executions 0",
      script: "aws-local",
    },
  ];
  const step = (s: Sample) => {
    const ev = d.observe(s, burnOf(s, rates));
    track(d.state.incident, ev, s, burnOf(s, rates), 15, changes);
  };
  step(sample({}));
  step(sample({ reservedConcurrency: 0 })); // the storm is still in the window: it opens now
  const inc = d.state.incident!;
  assert.equal(inc.containedBeforeAlert, true);
  assert.match(timeToContain(inc), /contained before alert/);
  assert.equal(inc.timeline.filter((e) => e.kind === "action")[0]?.source, "agent");
});

test("time to contain runs from the alert to the containment action", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  const step = (s: Sample, changes: ChangeRecord[] = []) => {
    const ev = d.observe(s, burnOf(s, rates));
    track(d.state.incident, ev, s, burnOf(s, rates), 15, changes);
  };
  step(sample({}));
  step(sample({}));
  const inc = d.state.incident!;
  const at = iso(clock + 40_000);
  clock += 30_000;
  step(sample({ reservedConcurrency: 0 }), [
    {
      at,
      source: "agent",
      op: "lambda put-function-concurrency",
      command: "x",
      script: "aws-local",
    },
  ]);
  assert.equal(inc.containmentActionAt, at);
  assert.equal(timeToContain(inc), "40s"); // alert → the command, not → the next sample
});

test("cost avoided = (peak − baseline) × unnoticed hours, with the assumption stated", () => {
  const d = new Detector(t, { usdPerHr: 0.01, invocationsPerMin: 120 });
  d.observe(sample({}), burnOf(sample({}), rates));
  const [ev] = d.observe(sample({}), burnOf(sample({}), rates));
  const inc = ev!.incident;
  inc.peakUsdPerHr = 0.11;
  inc.baselineUsdPerHr = 0.01;
  const c = costAvoided(inc, {
    ...t,
    cost: { unnoticed_hours: 8, unnoticed_assumption: "overnight" },
  });
  assert.ok(Math.abs(c.usd - 0.8) < 1e-9);
  assert.match(c.text, /× 8 h.*overnight/);
});

test("runbook steps map to the change they make", () => {
  assert.equal(requestKind("@claude-code run 3a"), "concurrency");
  assert.equal(requestKind("@claude-code run 4b"), "code");
  assert.equal(requestKind("@claude-code run 4c"), "mapping");
  assert.equal(requestKind("@claude-code run 4d"), "redrive");
  assert.equal(requestKind("@claude-code run 4e"), "concurrency");
  assert.equal(requestKind("@claude-code run 4f"), "move");
  assert.equal(parseRequest("@claude-code run 4c"), "@claude-code run 4c");
  assert.equal(parseRequest("looks good"), undefined);
});

test("a change seen before its log line is attributed on a later sample (INC-0348's 4c)", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  const step = (s: Sample, changes: ChangeRecord[]) => {
    const ev = d.observe(s, burnOf(s, rates));
    track(d.state.incident, ev, s, burnOf(s, rates), 15, changes);
  };
  step(sample({}), []);
  step(sample({}), []);
  const inc = d.state.incident!;
  noteRequest(inc, "jeevesh2605", "@claude-code run 4c", "r1", iso(clock + 2_000));
  // The sample sees ReportBatchItemFailures, but bin/aws-local hasn't logged it yet.
  step(sample({ partialBatchResponse: true }), []);
  const e = inc.timeline.find((x) => x.category === "mapping")!;
  assert.equal(e.source, "unknown");
  const late: ChangeRecord = {
    at: new Date(Date.parse(e.at) - 900).toISOString(),
    source: "agent",
    op: "lambda update-event-source-mapping",
    command:
      "lambda update-event-source-mapping --uuid u --function-response-types ReportBatchItemFailures",
    script: "aws-local",
  };
  step(sample({ partialBatchResponse: true }), [late]);
  assert.equal(e.source, "agent");
  assert.equal(e.changedAt, late.at);
  const i = inc.timeline.indexOf(e);
  assert.equal(matchRequests(inc).get(i)?.text, "@claude-code run 4c");
  assert.equal(changeSummary(inc).approved, 1); // the request counts, before any approval line
});

test("a request more than 2 min before the change isn't paired", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  d.observe(sample({}), burnOf(sample({}), rates));
  const [ev] = d.observe(sample({}), burnOf(sample({}), rates));
  const inc = ev!.incident;
  noteRequest(inc, "jeevesh2605", "@claude-code run 4b", "r2", iso(clock - 180_000));
  inc.timeline.push({
    at: iso(clock),
    kind: "action",
    text: "New code deployed",
    category: "code",
    source: "agent",
  });
  assert.equal(matchRequests(inc).get(inc.timeline.length - 1), undefined);
});

test("a DLQ move is recorded from the change log", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  const step = (s: Sample, changes: ChangeRecord[] = []) => {
    const ev = d.observe(s, burnOf(s, rates));
    track(d.state.incident, ev, s, burnOf(s, rates), 15, changes);
  };
  step(sample({}));
  step(sample({}));
  const inc = d.state.incident!;
  const move: ChangeRecord = {
    at: iso(clock + 5_000),
    source: "agent",
    op: "sqs start-message-move-task",
    command: "sqs start-message-move-task --source-arn a --destination-arn b",
    script: "aws-local",
  };
  step(sample({}), [move]);
  step(sample({}), [move]); // not twice
  const moves = inc.timeline.filter((e) => e.category === "move");
  assert.equal(moves.length, 1);
  assert.equal(moves[0]!.source, "agent");
});
