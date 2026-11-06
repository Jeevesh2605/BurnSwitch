// Switch side of `npm run demo:reset` (run while the watchdog is stopped).
//   --room "<name>"   switch to another room (e.g. a fresh Telegram group): saves its id in
//                     .env, adds @burn-watchdog and @claude-code, sets the room instructions
//                     from room/instructions.md. @finops-auditor is left out: it joins late.
// Always: deletes the watchdog's cost-ledger.md in the room, so the next run starts with an
// empty ledger (and the watchdog can't restore old incidents from it).
import "../watchdog/src/env.js";
import { readFileSync, rmSync } from "node:fs";
import { requireEnv } from "../watchdog/src/env.js";
import { LEDGER_NAME } from "../watchdog/src/ledger/ledger.js";
import { stateFile } from "../watchdog/src/stateDir.js";
import { resolveBridgeUrl } from "../watchdog/src/switch/config.js";
import { SwitchConnection } from "../watchdog/src/switch/connection.js";
import { setEnvValues } from "../watchdog/src/switch/envfile.js";
import { SwitchHttp } from "../watchdog/src/switch/http.js";

const say = (m: string) => console.log(`  ${m}`);
const roomArg = process.argv.indexOf("--room");
const roomName = roomArg >= 0 ? process.argv[roomArg + 1] : undefined;
const handoff = process.env.HANDOFF_AGENT || "claude-code";

const base = await resolveBridgeUrl();
const agentId = requireEnv("SWITCH_AGENT_ID");
const http = new SwitchHttp(base, agentId, requireEnv("SWITCH_AGENT_API_KEY"));

if (roomName) {
  type Room = { room_id: string; name: string; archived?: boolean };
  const rooms = (await http.op<Room[]>("list_all_rooms")).filter((r) => !r.archived);
  // Bridged rooms are named "<bot>: <group>", e.g. "BurnSwitch: finops-control". An exact
  // match on the full name or the group part wins; otherwise any name containing the text.
  const want = roomName.toLowerCase();
  const group = (n: string) => n.slice(n.indexOf(": ") + 2).toLowerCase();
  const exact = rooms.filter((r) => r.name.toLowerCase() === want || group(r.name) === want);
  const hits = exact.length ? exact : rooms.filter((r) => r.name.toLowerCase().includes(want));
  if (hits.length !== 1) {
    console.error(
      `Expected one room matching "${roomName}", found ${hits.length}: ` +
        rooms.map((r) => r.name).join(", "),
    );
    process.exit(1);
  }
  const room = hits[0]!;
  setEnvValues({ SWITCH_ROOM_ID: room.room_id });
  rmSync(stateFile("switch-connection.json"), { force: true }); // cursor belonged to the old room
  for (const name of ["burn-watchdog", handoff]) {
    await http.op("invite_agent_to_room", { room_id: room.room_id, agent_name: name });
    say(`@${name} is in "${room.name}"`);
  }
  const instructions = readFileSync(new URL("../room/instructions.md", import.meta.url), "utf8");
  await http.op("update_room", { room_id: room.room_id, instructions });
  say("room instructions set from room/instructions.md");
}

// Deleting the ledger needs a connection bound to the room, so connect briefly.
const roomId = requireEnv("SWITCH_ROOM_ID");
const conn = new SwitchConnection(base, agentId, requireEnv("SWITCH_AGENT_API_KEY"), roomId);
http.connectionId = conn.connectionId;
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("couldn't connect to Switch in 15 s")), 15_000);
  conn.once("ready", () => {
    clearTimeout(t);
    resolve();
  });
  conn.start();
});
type Doc = { id: string; name: string; created_by_agent_id?: string | null };
const { documents = [] } = await http.op<{ documents?: Doc[] }>("list_references");
const ledger = documents.find((d) => d.name === LEDGER_NAME && d.created_by_agent_id === agentId);
if (ledger) {
  await http.op("delete_room_document", { document_id: ledger.id });
  say(`deleted ${LEDGER_NAME} (the watchdog creates a fresh one when it starts)`);
} else say(`no ${LEDGER_NAME} in this room yet`);
conn.stop("demo reset done");
process.exit(0);
