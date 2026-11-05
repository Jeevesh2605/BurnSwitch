// npm run burn:start: launches the traffic generator in the background.
// Env: TRAFFIC_RPS (default 2), POISON_COUNT (default 5), POISON_DELAY_S (default 15).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOG_FILE, PID_FILE, STATE_DIR, queueUrl, realAws } from "./aws.js";

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (existsSync(PID_FILE)) {
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  if (isRunning(pid)) {
    console.log(`Traffic generator already running (pid ${pid}). Stop it with npm run burn:stop.`);
    process.exit(0);
  }
}

await queueUrl("orders"); // fail fast if the scenario isn't up

mkdirSync(STATE_DIR, { recursive: true });
const out = openSync(LOG_FILE, "a");
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    fileURLToPath(new URL("traffic.ts", import.meta.url)),
    ...(realAws ? ["--real-aws"] : []),
  ],
  { detached: true, stdio: ["ignore", out, out], env: process.env },
);
child.unref();
writeFileSync(PID_FILE, String(child.pid));

console.log(`Burn started (pid ${child.pid}). Log: .state/traffic.log`);
console.log(`Poison messages arrive in ${process.env.POISON_DELAY_S ?? 15}s.`);
console.log("Watch it: npm run scenario:status -- --watch");
