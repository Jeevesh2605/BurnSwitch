// npm run watchdog:register
// One-time registration of @burn-watchdog with the Switch server.
//   1. POST /agents with the registration key -> {id, api_key}. The key is shown once,
//      so it is written to .env immediately, before anything else can fail.
//   2. update_agent_detail: addressing = owner_and_owner_agents.
//   3. Find the #finops-control room, save its id, and invite the watchdog into it.
// Re-running is safe: an existing registration in .env is reused, never overwritten.
import "../env.js";
import { requireEnv } from "../env.js";
import { log } from "../log.js";
import { resolveBridgeUrl } from "./config.js";
import { setEnvValues } from "./envfile.js";
import { SwitchHttp, SwitchHttpError } from "./http.js";

const AGENT_NAME = "burn-watchdog";
const ROOM_MATCH = process.env.SWITCH_ROOM_NAME ?? "finops-control";

const base = await resolveBridgeUrl();
setEnvValues({ SWITCH_BRIDGE_URL: base });
log("info", `bridge OK at ${base}`);

let agentId = process.env.SWITCH_AGENT_ID;
let apiKey = process.env.SWITCH_AGENT_API_KEY;

if (agentId && apiKey) {
  log("info", `already registered as ${agentId}; reusing the key in .env`);
} else {
  const regKey = requireEnv("SWITCH_REGISTRATION_KEY");
  const res = await fetch(`${base}/agents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${regKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: AGENT_NAME,
      display_name: "Burn Watchdog",
      description:
        "Watches AWS Lambda/SQS spend for order-worker, raises one alert per cost incident, " +
        "and keeps the cost-ledger.md room document.",
      connector_type: "burnswitch-watchdog",
      integration_profile: {
        connection_model: "always_on",
        message_exchange: true,
        pre_invocation_mediation: [],
        post_invocation_mediation: [],
        event_reporting: [],
      },
    }),
  });
  const text = await res.text();
  if (res.status === 409) {
    throw new Error(
      `An agent named ${AGENT_NAME} already exists, and its API key isn't in .env. ` +
        "Re-registering with overwrite would issue a new key; delete the agent in Switch Console " +
        "or ask me to add an --overwrite option.",
    );
  }
  if (!res.ok) throw new Error(`registration failed: HTTP ${res.status} ${text}`);
  const body = JSON.parse(text) as { id: string; api_key: string };
  agentId = body.id;
  apiKey = body.api_key;
  setEnvValues({ SWITCH_AGENT_ID: agentId, SWITCH_AGENT_API_KEY: apiKey });
  log("info", `registered ${AGENT_NAME} as ${agentId}; API key saved to .env`);
}

const http = new SwitchHttp(base, agentId, apiKey);

const ops = await http.listOps();
const needed = [
  "update_agent_detail",
  "list_all_rooms",
  "invite_agent_to_room",
  "connect_to_room",
  "post_message",
  "send_targeted_message",
  "read_context",
  "create_room_document",
  "update_room_document",
];
const missing = needed.filter((o) => !(o in ops));
if (missing.length) log("warn", `server lacks operations: ${missing.join(", ")}`);
else log("info", `all ${needed.length} operations the watchdog uses are available`);

try {
  await http.op("update_agent_detail", { agent_id: agentId, addressing: "owner_and_owner_agents" });
  log("info", "addressing set to owner_and_owner_agents");
} catch (err) {
  // switch-core 0.31.0 refuses self-updates (the docs say it's allowed). New agents already
  // admit their owner and the owner's agents, which is what the watchdog needs.
  if (!(err instanceof SwitchHttpError && err.status === 403)) throw err;
  log(
    "warn",
    "server won't let the agent set its own addressing; keeping the default " +
      "(owner + owner's agents). Change it in Switch Console if needed.",
  );
}

type Room = { room_id: string; name: string; archived?: boolean };
let roomId = process.env.SWITCH_ROOM_ID;
if (!roomId) {
  const rooms = await http.op<Room[]>("list_all_rooms");
  const matches = rooms.filter((r) => r.name.toLowerCase().includes(ROOM_MATCH));
  if (matches.length !== 1) {
    log("error", `expected one room matching "${ROOM_MATCH}", found ${matches.length}`, {
      rooms: rooms.map((r) => `${r.name} (${r.room_id})`),
    });
    process.exit(1);
  }
  roomId = matches[0]!.room_id;
  setEnvValues({ SWITCH_ROOM_ID: roomId });
  log("info", `room: ${matches[0]!.name} (${roomId})`);
}

try {
  await http.op("invite_agent_to_room", { room_id: roomId, agent_name: AGENT_NAME });
  log("info", `${AGENT_NAME} is in the room`);
} catch (err) {
  if (err instanceof SwitchHttpError && err.status === 403) {
    log(
      "error",
      "not allowed to invite the watchdog; add it to the room in Switch Console instead",
    );
  }
  throw err;
}

log("info", "done. Next: npm run watchdog:hello");
