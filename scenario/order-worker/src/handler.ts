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

// Simulates the downstream write (inventory + billing) each order needs.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const total = priceOrder(order);
    await sleep(120);
    console.log(JSON.stringify({ msg: "order priced", orderId: order.orderId, total }));
  }
}
