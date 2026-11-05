import { test } from "node:test";
import assert from "node:assert/strict";
import { Detector } from "../src/incident/detector.js";
import { burnOf } from "../src/cost/model.js";
import type { Thresholds } from "../src/config.js";
import type { Sample } from "../src/metrics/types.js";

// Made-up rates: these tests check the logic, not AWS prices.
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

let clock = Date.parse("2026-11-04T10:00:00Z");
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
    ...over,
  };
};
const healthy = () => sample({});
const storm = () =>
  sample({
    invocations: 240,
    errors: 200,
    billedMsSum: 240 * 600,
    maxReceiveCount: 12,
    queueInFlight: 200,
  });

function run(d: Detector, s: Sample) {
  return d.observe(s, burnOf(s, rates)).map((e) => e.type);
}

test("burn model: requests + GB-seconds", () => {
  const b = burnOf(healthy(), rates);
  // 7200 req/hr * $1/M + 7200 * 0.13s * 0.5GB * $0.001
  assert.ok(Math.abs(b.usdPerHr - (0.0072 + 0.468)) < 1e-9);
  assert.equal(b.errorRate, 0);
});

test("opens exactly one incident for a sustained storm", () => {
  const d = new Detector(t, { usdPerHr: 0.475, invocationsPerMin: 120 });
  for (let i = 0; i < 3; i++) assert.deepEqual(run(d, healthy()), []);
  assert.deepEqual(run(d, storm()), []); // one bad sample isn't enough
  assert.deepEqual(run(d, storm()), ["opened"]);
  for (let i = 0; i < 10; i++) assert.deepEqual(run(d, storm()), []); // no duplicates
  assert.equal(d.state.incident?.status, "burning");
});

test("a single spike does not alert", () => {
  const d = new Detector(t, { usdPerHr: 0.475, invocationsPerMin: 120 });
  run(d, healthy());
  run(d, storm());
  assert.deepEqual(run(d, healthy()), []);
  assert.deepEqual(run(d, storm()), []);
  assert.equal(d.state.incident, undefined);
});

test("errors without retries (receive count 1) do not alert", () => {
  const d = new Detector(t, { usdPerHr: 0.475, invocationsPerMin: 120 });
  const s = () =>
    sample({ invocations: 240, errors: 200, billedMsSum: 240 * 600, maxReceiveCount: 1 });
  run(d, s());
  assert.deepEqual(run(d, s()), []);
});

test("contained, then resolved; state survives a restart", () => {
  const d = new Detector(t, { usdPerHr: 0.475, invocationsPerMin: 120 });
  run(d, storm());
  run(d, storm());
  const contained = () =>
    sample({
      invocations: 0,
      errors: 0,
      billedMsSum: 0,
      reservedConcurrency: 0,
      queueVisible: 200,
    });
  run(d, contained());
  assert.deepEqual(run(d, contained()), ["contained"]);

  // Restart: a new detector from the saved state carries on with the same incident.
  const d2 = new Detector(
    t,
    { usdPerHr: 0.475, invocationsPerMin: 120 },
    JSON.parse(JSON.stringify(d.state)),
  );
  const id = d2.state.incident!.id;
  run(d2, sample({ dlqVisible: 30 }));
  assert.deepEqual(run(d2, sample({ dlqVisible: 30 })), ["resolved"]);
  assert.equal(d2.state.closed.at(-1)?.id, id);
  assert.equal(d2.state.closed.at(-1)?.dlqAtResolve, 30);
  assert.equal(d2.state.incident, undefined);
});
