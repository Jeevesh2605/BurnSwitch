import { randomUUID } from "node:crypto";

const SKUS = ["SKU-TEA", "SKU-MUG", "SKU-KETTLE", "SKU-FILTER"];
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;

export function normalOrder() {
  return {
    orderId: `ord-${randomUUID().slice(0, 8)}`,
    customerId: `cus-${Math.floor(Math.random() * 900 + 100)}`,
    items: Array.from({ length: Math.floor(Math.random() * 3) + 1 }, () => ({
      sku: pick(SKUS),
      qty: Math.floor(Math.random() * 3) + 1,
      unitPrice: pick([4.5, 12, 29.99, 7.25]),
    })),
  };
}

// The poison message: an upstream client renamed `items` to `lineItems`.
// order-worker reads `order.items.reduce(...)` with no validation, so it throws.
export function poisonOrder() {
  const { items, ...rest } = normalOrder();
  return { ...rest, lineItems: items, source: "checkout-v2" };
}
