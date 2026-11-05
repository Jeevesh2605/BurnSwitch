import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { emptyState, type DetectorState } from "./detector.js";

const DIR = new URL("../../../.state/", import.meta.url);
const FILE = new URL("watchdog-state.json", DIR);

/** Detector state survives restarts, so an open incident is never alerted twice. */
export function loadState(): DetectorState {
  if (!existsSync(FILE)) return emptyState();
  try {
    return { ...emptyState(), ...(JSON.parse(readFileSync(FILE, "utf8")) as DetectorState) };
  } catch {
    return emptyState();
  }
}

export function saveState(state: DetectorState): void {
  mkdirSync(DIR, { recursive: true });
  const tmp = new URL("watchdog-state.json.tmp", DIR);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, FILE);
}
