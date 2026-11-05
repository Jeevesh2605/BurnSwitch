import { test } from "node:test";
import assert from "node:assert/strict";
import { handler, priceOrder } from "../src/handler.js";
import type { SQSEvent } from "../src/types.js";

const record = (body: unknown, messageId = "m-1") => ({
  messageId,
  receiptHandle: "rh",
  body: JSON.stringify(body),
  attributes: { ApproximateReceiveCount: "1" },
  eventSourceARN: "arn:aws:sqs:us-east-1:000000000000:orders",
});

test("priceOrder adds 8% tax", () => {
  const total = priceOrder({
    orderId: "o-1",
    customerId: "c-1",
    items: [{ sku: "A", qty: 2, unitPrice: 10 }],
  });
  assert.equal(total, 21.6);
});

test("handler processes a batch of valid orders", async () => {
  const event: SQSEvent = {
    Records: [
      record({ orderId: "o-1", customerId: "c-1", items: [{ sku: "A", qty: 1, unitPrice: 5 }] }),
    ],
  };
  assert.deepEqual(await handler(event), { batchItemFailures: [] });
});

test("malformed order fails alone, fast, without retries", async () => {
  const event: SQSEvent = {
    Records: [
      record({ orderId: "o-1", customerId: "c-1", items: [{ sku: "A", qty: 1, unitPrice: 5 }] }, "good"),
      record(
        {
          orderId: "o-2",
          customerId: "c-2",
          lineItems: [{ sku: "B", qty: 1, unitPrice: 29.99 }],
          source: "checkout-v2",
        },
        "bad-v2",
      ),
      { ...record({}, "bad-json"), body: "{not json" },
    ],
  };
  const t0 = Date.now();
  const res = await handler(event);
  assert.deepEqual(res, {
    batchItemFailures: [{ itemIdentifier: "bad-v2" }, { itemIdentifier: "bad-json" }],
  });
  assert.ok(Date.now() - t0 < 900, "validation errors must not be retried with backoff");
});
