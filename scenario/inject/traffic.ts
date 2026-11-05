// Background traffic generator, started by burn:start and stopped by burn:stop.
// Sends steady normal orders. After a delay (so the watchdog sees a normal baseline
// first), the "checkout-v2" client starts sending malformed orders: an initial burst,
// then a share of all traffic. Stuck batches pile up, so retries keep climbing.
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqs, queueUrl } from "./aws.js";
import { normalOrder, poisonOrder } from "./orders.js";
import { loadStats, saveStats } from "./stats.js";

const RPS = Number(process.env.TRAFFIC_RPS ?? 2);
const POISON_COUNT = Number(process.env.POISON_COUNT ?? 5);
const POISON_DELAY_S = Number(process.env.POISON_DELAY_S ?? 15);
const POISON_RATE = Number(process.env.POISON_RATE ?? 0.2); // share of orders after the delay

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const url = await queueUrl("orders");
const send = (body: unknown) =>
  sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify(body) }));

log(
  `normal traffic: ${RPS} orders/s; in ${POISON_DELAY_S}s: ${POISON_COUNT} poison messages, ` +
    `then ${Math.round(POISON_RATE * 100)}% of orders malformed`,
);

// Counts only what SQS accepted, so the reconciliation is exact.
const stats = loadStats();
stats.running = true;
stats.runs.push({ startedAt: new Date().toISOString() });
saveStats(stats);
const counted = (bad: boolean) => {
  if (bad) stats.malformed += 1;
  else stats.normal += 1;
  saveStats(stats);
  const total = stats.normal + stats.malformed;
  if (total % 50 === 0)
    log(`sent ${total} orders (${stats.malformed} malformed) since ${stats.since}`);
};
// Sends still on their way when burn:stop arrives are waited for, so an order that reaches SQS
// is always counted (otherwise the reconciliation is off by the orders in transit).
let pending = 0;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  for (let i = 0; i < 50 && pending > 0; i++) await new Promise((r) => setTimeout(r, 100));
  stats.running = false;
  stats.runs[stats.runs.length - 1]!.stoppedAt = new Date().toISOString();
  saveStats(stats);
  log(
    `stopped: ${stats.normal} normal + ${stats.malformed} malformed orders in SQS since ${stats.since}`,
  );
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

let poisoning = false;
const sendCounted = async (bad: boolean) => {
  pending += 1;
  try {
    await send(bad ? poisonOrder() : normalOrder());
    counted(bad);
  } catch (err) {
    log(`send failed: ${err}`);
  } finally {
    pending -= 1;
  }
};

const timer = setInterval(() => {
  if (!stopping) void sendCounted(poisoning && Math.random() < POISON_RATE);
}, 1000 / RPS);

setTimeout(async () => {
  for (let i = 0; i < POISON_COUNT && !stopping; i++) await sendCounted(true);
  poisoning = POISON_RATE > 0;
  log(`sent ${POISON_COUNT} poison messages (lineItems instead of items); checkout-v2 is live`);
}, POISON_DELAY_S * 1000);
