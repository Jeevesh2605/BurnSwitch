// npm run ledger:show
// Prints cost-ledger.md as stored in Switch. Telegram can't open room documents and
// Switch Console doesn't show a Telegram room's chat, so this is the quickest way to read it.
// Uses the watchdog's connection id (document ops need the connection bound to the room);
// a plain HTTP call doesn't disturb the watchdog's live WebSocket.
import "../env.js";
import { existsSync, readFileSync } from "node:fs";
import { requireEnv } from "../env.js";
import { stateFile } from "../stateDir.js";
import { resolveBridgeUrl } from "../switch/config.js";
import { SwitchHttp } from "../switch/http.js";
import { LEDGER_NAME } from "./ledger.js";

const conn = stateFile("switch-connection.json");
if (!existsSync(conn)) {
  console.error("No watchdog connection yet: start the watchdog once (npm run watchdog:dev).");
  process.exit(1);
}

const agentId = requireEnv("SWITCH_AGENT_ID");
const http = new SwitchHttp(await resolveBridgeUrl(), agentId, requireEnv("SWITCH_AGENT_API_KEY"));
http.connectionId = (
  JSON.parse(readFileSync(conn, "utf8")) as { connectionId: string }
).connectionId;

type Doc = { id: string; name: string; created_by_agent_id?: string | null };
const { documents = [] } = await http.op<{ documents?: Doc[] }>("list_references");
const doc = documents.find((d) => d.name === LEDGER_NAME && d.created_by_agent_id === agentId);
if (!doc) {
  console.error(`${LEDGER_NAME} isn't in the room yet: the watchdog creates it when it connects.`);
  process.exit(1);
}
const [loaded] = await http.op<{ content: string }[]>("load_internal_documents", { ids: [doc.id] });
process.stdout.write(loaded?.content ?? "");
