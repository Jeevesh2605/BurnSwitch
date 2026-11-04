// Background traffic generator, started by burn:start and stopped by burn:stop.
// Sends steady normal orders, then a burst of poison messages after a delay
// (so the watchdog sees a normal baseline first).
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqs, queueUrl } from "./aws.js";
import { normalOrder, poisonOrder } from "./orders.js";

const RPS = Number(process.env.TRAFFIC_RPS ?? 2);
const POISON_COUNT = Number(process.env.POISON_COUNT ?? 5);
const POISON_DELAY_S = Number(process.env.POISON_DELAY_S ?? 15);

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const url = await queueUrl("orders");
const send = (body: unknown) =>
  sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify(body) }));

log(`normal traffic: ${RPS} orders/s; ${POISON_COUNT} poison messages in ${POISON_DELAY_S}s`);

let sent = 0;
setInterval(() => {
  send(normalOrder())
    .then(() => {
      sent += 1;
      if (sent % 50 === 0) log(`sent ${sent} normal orders`);
    })
    .catch((err) => log(`send failed: ${err}`));
}, 1000 / RPS);

setTimeout(async () => {
  for (let i = 0; i < POISON_COUNT; i++) await send(poisonOrder());
  log(`sent ${POISON_COUNT} poison messages (lineItems instead of items)`);
}, POISON_DELAY_S * 1000);
