// npm run burn:stop: stops the traffic generator. Messages already sent stay in the queue.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { PID_FILE } from "./aws.js";

if (!existsSync(PID_FILE)) {
  console.log("No traffic generator running.");
  process.exit(0);
}
const pid = Number(readFileSync(PID_FILE, "utf8"));
try {
  process.kill(pid, "SIGTERM");
  console.log(`Stopped traffic generator (pid ${pid}).`);
} catch {
  console.log(`Traffic generator (pid ${pid}) was not running.`);
}
rmSync(PID_FILE);
