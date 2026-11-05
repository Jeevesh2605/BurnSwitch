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

// A payload that can never be priced. Retrying it is pointless, so withRetry rethrows at once.
export class ValidationError extends Error {
  override name = "ValidationError";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseOrder(body: string): Order {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ValidationError("body is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new ValidationError("body is not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.orderId !== "string" || !o.orderId) throw new ValidationError("missing orderId");
  if (typeof o.customerId !== "string" || !o.customerId) throw new ValidationError("missing customerId");
  if (!Array.isArray(o.items) || o.items.length === 0) throw new ValidationError("missing or empty items");
  for (const item of o.items as unknown[]) {
    const i = item as Record<string, unknown> | null;
    if (!i || typeof i.sku !== "string" || !isNum(i.qty) || i.qty <= 0 || !isNum(i.unitPrice) || i.unitPrice < 0) {
      throw new ValidationError("invalid item");
    }
  }
  return o as unknown as Order;
}

export function priceOrder(order: Order): number {
  const subtotal = order.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  return Math.round(subtotal * 1.08 * 100) / 100; // 8% tax
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Smooths over flaky downstream calls: up to 3 attempts, backing off 1s then 2s.
// Validation errors are never retried: they will fail the same way every time.
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

// Reports only the failed messages (needs ReportBatchItemFailures on the event source mapping),
// so good orders in the same batch are deleted instead of being retried with the bad one.
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
      const e = err as Error;
      console.error(
        JSON.stringify({
          msg: e instanceof ValidationError ? "invalid order" : "order failed",
          messageId: record.messageId,
          error: e.message,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
