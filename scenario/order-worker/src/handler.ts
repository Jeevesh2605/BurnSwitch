// order-worker: consumes the `orders` SQS queue and prices each order.
//
// Deployed in commit 8f3a1c ("order-worker: compute order totals inline").
import type { SQSBatchResponse, SQSEvent } from "./types.js";

export interface OrderItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Order {
  orderId: string;
  customerId: string;
  items: OrderItem[];
}

export function priceOrder(order: Order): number {
  const subtotal = order.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  return Math.round(subtotal * 1.08 * 100) / 100; // 8% tax
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A payload that can never be priced. Retrying it is pointless.
export class ValidationError extends Error {
  override name = "ValidationError";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function parseOrder(body: string): Order {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ValidationError("body is not valid JSON");
  }
  if (!isObject(data)) throw new ValidationError("order is not an object");
  if (typeof data.orderId !== "string" || !data.orderId) throw new ValidationError("missing orderId");
  if (typeof data.customerId !== "string" || !data.customerId) throw new ValidationError("missing customerId");
  if (!Array.isArray(data.items)) throw new ValidationError("missing items array");
  data.items.forEach((item, i) => {
    if (
      !isObject(item) ||
      typeof item.sku !== "string" ||
      typeof item.qty !== "number" ||
      !Number.isFinite(item.qty) ||
      typeof item.unitPrice !== "number" ||
      !Number.isFinite(item.unitPrice)
    ) {
      throw new ValidationError(`invalid item at index ${i}`);
    }
  });
  return data as unknown as Order;
}

// Smooths over flaky downstream calls: up to 3 attempts, backing off 1s then 2s.
// Validation errors are never retried: they will never succeed.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 1000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ValidationError || i >= attempts) throw err;
      await sleep(baseMs * 2 ** (i - 1));
    }
  }
}

async function processOrder(order: Order): Promise<number> {
  const total = priceOrder(order);
  await sleep(120); // the downstream write (inventory + billing) each order needs
  return total;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  const receives = event.Records.map((r) => Number(r.attributes.ApproximateReceiveCount));
  console.log(
    JSON.stringify({
      msg: "batch received",
      size: receives.length,
      maxReceiveCount: Math.max(...receives),
    }),
  );
  for (const record of event.Records) {
    try {
      const order = parseOrder(record.body);
      const total = await withRetry(() => processOrder(order));
      console.log(JSON.stringify({ msg: "order priced", orderId: order.orderId, total }));
    } catch (err) {
      // Fail only this message; the rest of the batch is kept.
      batchItemFailures.push({ itemIdentifier: record.messageId });
      console.log(
        JSON.stringify({
          msg: err instanceof ValidationError ? "order rejected" : "order failed",
          messageId: record.messageId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return { batchItemFailures };
}
