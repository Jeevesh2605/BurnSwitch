// npm run metrics:record -- <seconds> [name]
// Records live samples (LocalStack probe) into watchdog/fixtures/<name>.json for the replay adapter.
import "../env.js";
import { writeFileSync } from "node:fs";
import { loadThresholds } from "../config.js";
import { log } from "../log.js";
import { LocalstackProbe } from "./localstackProbe.js";
import type { Fixture } from "./replay.js";

const seconds = Number(process.argv[2] ?? 300);
const name = process.argv[3] ?? "storm";
const t = loadThresholds();
const probe = new LocalstackProbe(t.function, t.queue, t.dlq, t.window_s);
const out = new URL(`../../fixtures/${name}.json`, import.meta.url);
const fixture: Fixture = {
  recorded_at: new Date().toISOString(),
  interval_s: t.sample_interval_s,
  source: probe.name,
  samples: [],
};

const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  const s = await probe.sample();
  fixture.samples.push(s);
  writeFileSync(out, JSON.stringify(fixture, null, 2));
  log(
    "info",
    `sample ${fixture.samples.length}: ${s.invocations} inv, ${s.errors} err, rc ${s.maxReceiveCount}`,
  );
  await new Promise((r) => setTimeout(r, t.sample_interval_s * 1000));
}
log("info", `saved ${fixture.samples.length} samples to ${out.pathname}`);
