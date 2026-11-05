// Where the watchdog keeps its state: .state/ by default. WATCHDOG_STATE_DIR moves it (the
// resilience tests run a dry-run watchdog with its own state, so it never touches the real one).
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function stateDir(): URL {
  const configured = process.env.WATCHDOG_STATE_DIR;
  const dir = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(ROOT, configured)
    : resolve(ROOT, ".state");
  mkdirSync(dir, { recursive: true });
  return pathToFileURL(dir.endsWith("/") ? dir : `${dir}/`);
}

export const stateFile = (name: string): URL => new URL(name, stateDir());
