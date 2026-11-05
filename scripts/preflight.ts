// npm run preflight: checks everything a demo run needs, before it starts.
// Read-only: it changes nothing anywhere. Exit code 1 if something blocks the run.
import "../watchdog/src/env.js";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadPricing } from "../watchdog/src/config.js";
import { resolveBridgeUrl } from "../watchdog/src/switch/config.js";
import { SwitchHttp } from "../watchdog/src/switch/http.js";

const realAws = process.argv.includes("--real-aws");
let blocking = 0;
const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const warn = (msg: string) => console.log(`  ⚠️  ${msg}`);
const fail = (msg: string) => {
  blocking += 1;
  console.log(`  ❌ ${msg}`);
};

console.log("Preflight");

// 1. Config
for (const name of ["SWITCH_AGENT_ID", "SWITCH_AGENT_API_KEY", "SWITCH_ROOM_ID"]) {
  if (!process.env[name]) fail(`${name} missing in .env (npm run watchdog:register)`);
}
try {
  loadPricing();
  ok("Lambda prices set in config/pricing.json");
} catch (err) {
  fail((err as Error).message);
}

// 2. Docker / LocalStack
if (!realAws) {
  try {
    const out = execFileSync("docker", ["info", "--format", "{{json .ServerVersion}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    ok(`Docker is running (${out.trim()})`);
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    fail(
      /paused/i.test(msg)
        ? "Docker Desktop is paused: resume it from the whale menu"
        : "Docker isn't running: start Docker Desktop",
    );
  }
  if (!process.env.LOCALSTACK_AUTH_TOKEN) fail("LOCALSTACK_AUTH_TOKEN missing in .env");
}

// 3. Switch, the room and its agents
try {
  const base = await resolveBridgeUrl();
  ok(`Switch bridge at ${base}`);
  const http = new SwitchHttp(
    base,
    process.env.SWITCH_AGENT_ID!,
    process.env.SWITCH_AGENT_API_KEY!,
  );
  const room = await http.op<{
    name: string;
    instructions?: string | null;
    agent_names?: string[];
    agent_statuses?: Record<string, unknown>;
  }>("get_room_detail", { room_id: process.env.SWITCH_ROOM_ID });
  ok(`room "${room.name}"`);
  const agents = room.agent_names ?? [];
  const status = (n: string) => {
    const s = room.agent_statuses?.[n];
    return s == null ? "" : ` (${typeof s === "string" ? s : JSON.stringify(s)})`;
  };
  for (const name of ["burn-watchdog", process.env.HANDOFF_AGENT || "claude-code"]) {
    if (agents.includes(name)) ok(`@${name} is in the room${status(name)}`);
    else fail(`@${name} isn't in the room: send !invite-agent @${name} in the group`);
  }
  if (agents.includes("finops-auditor")) {
    warn(
      "@finops-auditor is already in the room. For the late-join act, send " +
        "!remove-agent @finops-auditor now",
    );
  } else ok("@finops-auditor is not in the room yet (it joins in act 6)");
  const want = readFileSync(new URL("../room/instructions.md", import.meta.url), "utf8");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  if (!room.instructions)
    fail("room instructions are empty: paste room/instructions.md (setup step 2)");
  else if (norm(room.instructions) !== norm(want)) {
    warn(
      "room instructions differ from room/instructions.md: paste the file again if you edited it",
    );
  } else ok("room instructions match room/instructions.md");
} catch (err) {
  fail(`Switch: ${(err as Error).message}`);
}

console.log(blocking ? `\n${blocking} problem(s) to fix first.` : "\nAll set.");
process.exit(blocking ? 1 : 0);
