// Plays back a recorded run (watchdog/fixtures/*.json), one sample per call, so a demo or a
// judge gets the same incident every time with no AWS or LocalStack at all.
import { readFileSync } from "node:fs";
import type { MetricsAdapter, Sample } from "./types.js";

export interface Fixture {
  recorded_at: string;
  interval_s: number;
  source: string;
  samples: Sample[];
}

export class ReplayAdapter implements MetricsAdapter {
  readonly name = "replay";
  private readonly samples: Sample[];
  private i = 0;

  constructor(path: string) {
    const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
    if (!fixture.samples.length) throw new Error(`fixture ${path} has no samples`);
    this.samples = fixture.samples;
  }

  async sample(): Promise<Sample> {
    const s = this.samples[Math.min(this.i, this.samples.length - 1)]!;
    this.i += 1;
    return { ...s, at: new Date().toISOString() };
  }

  get finished(): boolean {
    return this.i >= this.samples.length;
  }
}
