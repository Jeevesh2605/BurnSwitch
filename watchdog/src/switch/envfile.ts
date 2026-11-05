import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const ENV_PATH = new URL("../../../.env", import.meta.url);

/** Sets KEY=value lines in .env (adding any that are missing), then updates process.env. */
export function setEnvValues(values: Record<string, string>): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
    process.env[key] = value;
  }
  const tmp = new URL("../../../.env.tmp", import.meta.url);
  writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
  renameSync(tmp, ENV_PATH);
}
