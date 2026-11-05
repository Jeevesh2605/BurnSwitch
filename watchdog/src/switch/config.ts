import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log.js";

// Switch Console's local server picks its own ports and records them here (macOS).
// SWITCH_CONSOLE_PORTS points elsewhere (other OSes, or the resilience tests).
const consolePorts = () =>
  process.env.SWITCH_CONSOLE_PORTS ??
  join(homedir(), "Library/Application Support/switchdash/local-switch-server/ports.json");

async function isHealthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The agent bridge base URL, verified with GET /health (public, and the documented
 * probe; the bridge is usually not the Gateway URL). Falls back to the port Switch
 * Console recorded, since a local server can move ports when it restarts.
 */
export async function resolveBridgeUrl(): Promise<string> {
  const configured = process.env.SWITCH_BRIDGE_URL?.replace(/\/+$/, "");
  if (configured && (await isHealthy(configured))) return configured;

  try {
    const ports = JSON.parse(readFileSync(consolePorts(), "utf8")) as { api?: number };
    if (ports.api) {
      const local = `http://127.0.0.1:${ports.api}`;
      if (await isHealthy(local)) {
        if (configured) log("warn", `SWITCH_BRIDGE_URL ${configured} is down; using ${local}`);
        return local;
      }
    }
  } catch {
    // No Switch Console on this machine (e.g. inside docker); nothing to fall back to.
  }
  throw new Error(
    `Switch bridge not reachable at ${configured ?? "(SWITCH_BRIDGE_URL unset)"}. ` +
      "Check that the server is running and that GET <url>/health returns 200.",
  );
}

export function wsUrl(httpBase: string): string {
  return httpBase.replace(/^http/, "ws");
}
