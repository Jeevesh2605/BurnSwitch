// npm run switch:registration-key
//
// Creates a Switch registration key on a server that Switch Console runs locally
// (that server has no Gateway web page, so there's no "API Keys" screen to click).
//
// How: Switch Console keeps its signed-in session cookie for the server, encrypted with
// Electron safeStorage (key in the macOS Keychain item "Switch Console Safe Storage").
// This script decrypts that cookie (macOS asks you to allow Keychain access), calls the
// same API the Gateway's API Keys page uses (POST /gateway/api-keys), and writes the new
// key to .env as SWITCH_REGISTRATION_KEY. Nothing secret is printed.
//
// On a server with a Gateway web page, create the key there instead (API Keys >
// Create Registration Key).
import "../watchdog/src/env.js";
import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBridgeUrl } from "../watchdog/src/switch/config.js";
import { setEnvValues } from "../watchdog/src/switch/envfile.js";

const DB = join(homedir(), "Library/Application Support/switchdash/switchdash.db");
const LABEL = process.argv[2] ?? "burn-watchdog";

if (process.env.SWITCH_REGISTRATION_KEY) {
  console.log("SWITCH_REGISTRATION_KEY is already set in .env; nothing to do.");
  process.exit(0);
}

// 1. The Keychain password Electron uses for safeStorage. macOS shows an "allow" prompt.
// Electron names the item "<app name> Safe Storage"; the app name may be the internal one.
const candidates = [
  process.env.SWITCH_KEYCHAIN_SERVICE,
  "Switchdash Safe Storage",
  "switchdash Safe Storage",
  "Switch Console Safe Storage",
  "Switch Safe Storage",
  "SwitchDash Safe Storage",
].filter((s): s is string => Boolean(s));

let keychainPassword: string | undefined;
for (const service of candidates) {
  try {
    keychainPassword = execFileSync("security", ["find-generic-password", "-w", "-s", service], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    console.log(`Using Keychain item "${service}".`);
    break;
  } catch {
    // Not this name; try the next.
  }
}
if (!keychainPassword) {
  console.error(
    `No Keychain item found under: ${candidates.join(", ")}.\n` +
      `List the "Safe Storage" item names (names only, no passwords) with:\n` +
      `  security dump-keychain | grep -i '"svce".*safe storage'\n` +
      `then rerun with SWITCH_KEYCHAIN_SERVICE="<that name>" npm run switch:registration-key`,
  );
  process.exit(1);
}

// 2. Chromium's macOS scheme: "v10" + AES-128-CBC, key = PBKDF2-SHA1(password, "saltysalt", 1003).
function decrypt(b64: string): string {
  const data = Buffer.from(b64, "base64");
  if (data.subarray(0, 3).toString() !== "v10") throw new Error("unexpected secret format");
  const key = pbkdf2Sync(keychainPassword!, "saltysalt", 1003, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]).toString("utf8");
}

const rows = execFileSync(
  "sqlite3",
  ["-readonly", DB, "SELECT secret FROM app_secrets WHERE key LIKE 'switch-server-cookie:%';"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);
if (rows.length !== 1) throw new Error(`expected one stored server session, found ${rows.length}`);

// 3. Turn what was stored into a Cookie header.
const stored = decrypt(rows[0]!).trim();
let cookie: string;
if (stored.startsWith("[") || stored.startsWith("{")) {
  const parsed = JSON.parse(stored) as unknown;
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as { name?: string; value?: string }[];
  cookie = list
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (!cookie && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const token = [o.switch_auth, o.token, o.value, o.cookie].find((v) => typeof v === "string");
    if (typeof token === "string") cookie = token.includes("=") ? token : `switch_auth=${token}`;
  }
} else if (stored.includes("=")) {
  cookie = stored;
} else {
  // A bare session token: the server reads it from the `switch_auth` cookie
  // (switch_core/gateway/auth.py).
  cookie = `switch_auth=${stored}`;
}
if (!cookie.includes("=") || /\s/.test(cookie.replace(/;\s/g, ""))) {
  throw new Error("couldn't read the stored session as a cookie; create the key another way");
}

// 4. Create the key exactly as the Gateway's API Keys page does.
const base = await resolveBridgeUrl();
const res = await fetch(`${base}/gateway/api-keys`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ label: LABEL }),
});
if (!res.ok) {
  const hint =
    res.status === 401
      ? " The stored session has expired: open Switch Console (it signs in again), then rerun."
      : "";
  throw new Error(`creating the key failed: HTTP ${res.status}.${hint}`);
}
const body = (await res.json()) as { id: string; label: string; key: string };
setEnvValues({ SWITCH_REGISTRATION_KEY: body.key });
console.log(`Created registration key "${body.label}" (id ${body.id}) and saved it to .env.`);
