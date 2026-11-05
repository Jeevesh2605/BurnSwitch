import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeployManifest, Thresholds } from "../src/config.js";
import { burnOf } from "../src/cost/model.js";
import { Detector } from "../src/incident/detector.js";
import { infraChanges, noteApproval, parseApproval, track } from "../src/incident/timeline.js";
import { ledgerKey, parseStateMarker, renderLedger } from "../src/ledger/ledger.js";
import { SwitchHttpError, isTransient } from "../src/switch/http.js";
import type { Sample } from "../src/metrics/types.js";

const rates = { lambda_requests_usd_per_million: 1, lambda_gb_second_usd: 0.001 };
const t: Thresholds = {
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
};
const deploy = {
  deploy: {
    commit: "8f3a1c",
    message: "order-worker: compute order totals inline",
    deployed_at: "2026-11-04T08:42:00Z",
  },
  config: { memory_mb: 512 },
} as DeployManifest;

let clock = Date.parse("2026-11-05T10:00:00Z");
const sample = (over: Partial<Sample>): Sample => {
  clock += 15_000;
  return {
    at: new Date(clock).toISOString(),
    windowS: 60,
    invocations: 120,
    errors: 0,
    billedMsSum: 120 * 130,
    memoryMb: 512,
    maxReceiveCount: 1,
    queueVisible: 0,
    queueInFlight: 1,
    dlqVisible: 0,
    redriveConfigured: false,
    reservedConcurrency: null,
    codeSha: "aaaaaaaaaaaaaaaa",
    mappingState: "Enabled",
    partialBatchResponse: false,
    ...over,
  };
};
const storm = (over: Partial<Sample> = {}) =>
  sample({ invocations: 240, errors: 200, billedMsSum: 240 * 600, maxReceiveCount: 12, ...over });

function step(d: Detector, s: Sample) {
  const b = burnOf(s, rates);
  const events = d.observe(s, b);
  track(d.state.incident, events, s, b, t.sample_interval_s);
  return events.map((e) => e.type);
}

test("infraChanges describes each change and skips what a source can't see", () => {
  const base = { reservedConcurrency: null, redriveConfigured: false, codeSha: "a" };
  assert.deepEqual(infraChanges(base, { ...base }), []);
  assert.match(infraChanges(base, { ...base, reservedConcurrency: 0 })[0]!, /set to 0/);
  assert.match(
    infraChanges(base, { ...base, redriveConfigured: true })[0]!,
    /Redrive policy added/,
  );
  assert.match(infraChanges(base, { ...base, codeSha: "b" })[0]!, /New code deployed/);
  // A replay fixture without codeSha must not look like a deploy.
  assert.deepEqual(infraChanges(base, { ...base, codeSha: undefined }), []);
});

test("a full incident: actions, spend, approvals, resolution in the ledger", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  for (let i = 0; i < 3; i++) step(d, sample({}));
  step(d, storm());
  assert.deepEqual(step(d, storm()), ["opened"]);
  const inc = d.state.incident!;
  step(d, storm());
  assert.ok(inc.spendUsd > 0 && inc.excessUsd > 0 && inc.excessUsd < inc.spendUsd);

  // Containment: concurrency 0, approved in the room.
  const ok = noteApproval(
    inc,
    parseApproval("Approved by jeevesh2605: put-function-concurrency 0")!,
    "claude-code",
    "m-1",
    new Date(clock).toISOString(),
  );
  assert.ok(ok);
  assert.equal(noteApproval(inc, { by: "x", action: "y" }, "claude-code", "m-1", ""), false);
  const paused = { reservedConcurrency: 0, invocations: 0, errors: 0, billedMsSum: 0 };
  step(d, sample(paused));
  step(d, sample(paused));
  assert.equal(inc.status, "contained");

  // Fix: new code, partial batch failures, redrive, concurrency back.
  const fixed = {
    codeSha: "bbbbbbbbbbbbbbbb",
    partialBatchResponse: true,
    redriveConfigured: true,
    reservedConcurrency: null,
    dlqVisible: 7,
  };
  step(d, sample(fixed));
  assert.deepEqual(step(d, sample(fixed)), ["resolved"]);

  const actions = inc.timeline.filter((e) => e.kind === "action").map((e) => e.text);
  assert.equal(actions.length, 5, actions.join("\n"));
  const doc = renderLedger(d.state, deploy, t, new Date(clock).toISOString());
  for (const want of [
    inc.id,
    "✅ resolved",
    "8f3a1c",
    "Time to contain",
    "Reserved concurrency set to 0",
    "| jeevesh2605 | put-function-concurrency 0 | @claude-code |",
    "Messages kept in orders-dlq | 7",
    "TODO(approvals)",
  ]) {
    assert.ok(doc.includes(want), `ledger is missing: ${want}`);
  }
});

test("ledgerKey ignores spend ticks but changes on timeline events", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  step(d, storm());
  step(d, storm());
  const k1 = ledgerKey(d.state);
  step(d, storm());
  assert.equal(ledgerKey(d.state), k1);
  step(d, storm({ reservedConcurrency: 5 }));
  assert.notEqual(ledgerKey(d.state), k1);
});

test("parseApproval", () => {
  assert.deepEqual(parseApproval("✅ Approved by @jeevesh2605 — aws sqs set-queue-attributes"), {
    by: "jeevesh2605",
    action: "aws sqs set-queue-attributes",
  });
  assert.equal(parseApproval("I approve of this plan"), undefined);
});

test("the ledger carries the incident state, so a lost .state/ resumes it", () => {
  const d = new Detector(t, { usdPerHr: 1, invocationsPerMin: 120 });
  step(d, storm());
  step(d, storm());
  const inc = d.state.incident!;
  const doc = renderLedger(d.state, deploy, t, new Date(clock).toISOString());
  const back = parseStateMarker(doc)!;
  assert.equal(back.incident?.id, inc.id);
  assert.equal(back.incident?.handoffSent, inc.handoffSent);
  assert.equal(parseStateMarker("# no marker here"), undefined);

  // A detector restored from it does not open a second incident for the same storm.
  const restored = new Detector(
    t,
    { usdPerHr: 1, invocationsPerMin: 120 },
    {
      ...d.state,
      ...back,
      healthy: [],
    },
  );
  assert.deepEqual(restored.observe(storm(), burnOf(storm(), rates)), []);
});

test("isTransient: retry on network trouble, not on refusals", () => {
  assert.equal(isTransient(new TypeError("fetch failed")), true);
  assert.equal(isTransient(new SwitchHttpError(503, "", "x")), true);
  assert.equal(isTransient(new SwitchHttpError(409, "connection abc is not open", "x")), true);
  assert.equal(isTransient(new SwitchHttpError(400, "Targets not in room", "x")), false);
});
