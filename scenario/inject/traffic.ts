// Background traffic generator, started by burn:start and stopped by burn:stop.
// Sends steady normal orders. After a delay (so the watchdog sees a normal baseline
// first), the "checkout-v2" client starts sending malformed orders: an initial burst,
// then a share of all traffic. Stuck batches pile up, so retries keep climbing.
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqs, queueUrl } from "./aws.js";
import { normalOrder, poisonOrder } from "./orders.js";

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

let poisoning = false;
let sent = 0;
let poisoned = 0;
setInterval(() => {
  const bad = poisoning && Math.random() < POISON_RATE;
  send(bad ? poisonOrder() : normalOrder())
    .then(() => {
      sent += 1;
      if (bad) poisoned += 1;
      if (sent % 50 === 0) log(`sent ${sent} orders (${poisoned} malformed)`);
    })
    .catch((err) => log(`send failed: ${err}`));
}, 1000 / RPS);

setTimeout(async () => {
  for (let i = 0; i < POISON_COUNT; i++) await send(poisonOrder());
  poisoned += POISON_COUNT;
  poisoning = POISON_RATE > 0;
  log(`sent ${POISON_COUNT} poison messages (lineItems instead of items); checkout-v2 is live`);
}, POISON_DELAY_S * 1000);
