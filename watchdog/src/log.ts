type Level = "info" | "warn" | "error" | "debug";

export function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (level === "debug" && !process.env.WATCHDOG_DEBUG) return;
  const line = `${new Date().toISOString()} [burn-watchdog] ${level.toUpperCase()} ${msg}`;
  const out = extra ? `${line} ${JSON.stringify(extra)}` : line;
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}
