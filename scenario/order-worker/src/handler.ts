// order-worker: consumes the `orders` SQS queue and prices each order.
//
// Deployed in commit 8f3a1c ("order-worker: compute order totals inline").
import type { SQSEvent } from "./types.js";

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

// Smooths over flaky downstream calls: up to 3 attempts, backing off 1s then 2s.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 1000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await sleep(baseMs * 2 ** (i - 1));
    }
  }
}

async function processOrder(order: Order): Promise<number> {
  const total = priceOrder(order);
  await sleep(120); // the downstream write (inventory + billing) each order needs
  return total;
}

export async function handler(event: SQSEvent): Promise<void> {
  const receives = event.Records.map((r) => Number(r.attributes.ApproximateReceiveCount));
  console.log(
    JSON.stringify({
      msg: "batch received",
      size: receives.length,
      maxReceiveCount: Math.max(...receives),
    }),
  );
  for (const record of event.Records) {
    const order = JSON.parse(record.body) as Order;
    const total = await withRetry(() => processOrder(order));
    console.log(JSON.stringify({ msg: "order priced", orderId: order.orderId, total }));
  }
}
