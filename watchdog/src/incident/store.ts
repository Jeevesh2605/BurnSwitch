import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stateFile } from "../stateDir.js";
import { emptyState, type DetectorState } from "./detector.js";

const FILE = () => stateFile("watchdog-state.json");

/** True if this watchdog has local state (false on a first run or after the file was lost). */
export const hasState = (): boolean => existsSync(FILE());

/** Detector state survives restarts, so an open incident is never alerted twice. */
export function loadState(): DetectorState {
  if (!existsSync(FILE())) return emptyState();
  try {
    return { ...emptyState(), ...(JSON.parse(readFileSync(FILE(), "utf8")) as DetectorState) };
  } catch {
    return emptyState();
  }
}

export function saveState(state: DetectorState): void {
  const tmp = stateFile("watchdog-state.json.tmp");
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, FILE());
}
