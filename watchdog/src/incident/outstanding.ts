// Used by scenario/bin/queue-check: prints how many good orders are still waiting.
//   good orders outstanding = normal orders sent − orders processed
import "../env.js";
import { outstandingGood } from "./reconcile.js";

const r = await outstandingGood("order-worker");
console.log(JSON.stringify(r ?? null));
