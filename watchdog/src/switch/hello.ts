// npm run watchdog:hello  (Checkpoint 2)
// Posts a hello into #finops-control with POST /agents/{id}/message, which needs no connection.
import "../env.js";
import { requireEnv } from "../env.js";
import { log } from "../log.js";
import { resolveBridgeUrl } from "./config.js";
import { SwitchHttp } from "./http.js";

const http = new SwitchHttp(
  await resolveBridgeUrl(),
  requireEnv("SWITCH_AGENT_ID"),
  requireEnv("SWITCH_AGENT_API_KEY"),
);
const text =
  process.argv.slice(2).join(" ") || "hello from burn-watchdog 👋 I'm watching order-worker spend.";
const res = await http.postMessage(requireEnv("SWITCH_ROOM_ID"), text);
log("info", `posted (event ${res.event_id})`);
