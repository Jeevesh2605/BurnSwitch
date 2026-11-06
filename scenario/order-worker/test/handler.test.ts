import { test } from "node:test";
import assert from "node:assert/strict";
import { handler, parseOrder, priceOrder, ValidationError } from "../src/handler.js";
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

test("malformed order (checkout-v2 lineItems) fails alone, fast, without retries", async () => {
  const event: SQSEvent = {
    Records: [
      record({ orderId: "o-1", customerId: "c-1", items: [{ sku: "A", qty: 1, unitPrice: 5 }] }, "good-1"),
      record({ orderId: "o-2", customerId: "c-2", lineItems: [{ sku: "B", quantity: 1, price: 5 }] }, "bad-1"),
      record({ orderId: "o-3", customerId: "c-3", items: [{ sku: "C", qty: 2, unitPrice: 3 }] }, "good-2"),
    ],
  };
  const start = Date.now();
  const res = await handler(event);
  const elapsed = Date.now() - start;
  assert.deepEqual(res, { batchItemFailures: [{ itemIdentifier: "bad-1" }] });
  assert.ok(elapsed < 1000, `validation error must not be retried (took ${elapsed} ms)`);
});

test("non-JSON body is reported as a failure, not thrown", async () => {
  const event: SQSEvent = {
    Records: [{ ...record({}, "bad-json"), body: "{not json" }],
  };
  assert.deepEqual(await handler(event), { batchItemFailures: [{ itemIdentifier: "bad-json" }] });
});

test("parseOrder rejects bad items", () => {
  assert.throws(
    () => parseOrder(JSON.stringify({ orderId: "o", customerId: "c", items: [{ sku: "A", qty: "2", unitPrice: 1 }] })),
    ValidationError,
  );
});
