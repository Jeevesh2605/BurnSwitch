// LocalStack only emits the Invocations and Errors metrics, not Duration, so this adapter
// reads the function's log lines instead:
//   REPORT ... Billed Duration: 127 ms  Memory Size: 512 MB   -> one invocation
//   ...\tERROR\tInvoke Error ...                                -> one failed invocation
//   {"msg":"batch received",...,"maxReceiveCount":7}             -> SQS receive counts
import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { aws } from "../aws.js";
import { readInfra } from "./queues.js";
import type { MetricsAdapter, Sample } from "./types.js";

const REPORT = /Billed Duration: (\d+) ms\s+Memory Size: (\d+) MB/;
const RECEIVE = /"maxReceiveCount":(\d+)/;

export class LocalstackProbe implements MetricsAdapter {
  readonly name = "localstack-probe";

  constructor(
    private readonly fn: string,
    private readonly queue: string,
    private readonly dlq: string,
    private readonly windowS: number,
  ) {}

  async sample(): Promise<Sample> {
    const now = Date.now();
    const [logs, infra] = await Promise.all([
      this.readLogs(now - this.windowS * 1000, now),
      readInfra(this.fn, this.queue, this.dlq),
    ]);
    return { at: new Date(now).toISOString(), windowS: this.windowS, ...logs, ...infra };
  }

  private async readLogs(startTime: number, endTime: number) {
    let invocations = 0;
    let errors = 0;
    let billedMsSum = 0;
    let memoryMb = 0;
    let maxReceiveCount: number | null = null;
    let nextToken: string | undefined;
    let pages = 0;
    do {
      let res;
      try {
        res = await aws.logs.send(
          new FilterLogEventsCommand({
            logGroupName: `/aws/lambda/${this.fn}`,
            startTime,
            endTime,
            nextToken,
          }),
        );
      } catch (err) {
        // No invocations yet means no log group yet.
        if ((err as Error).name === "ResourceNotFoundException") break;
        throw err;
      }
      for (const e of res.events ?? []) {
        const m = e.message ?? "";
        const report = REPORT.exec(m);
        if (report) {
          invocations += 1;
          billedMsSum += Number(report[1]);
          memoryMb = Number(report[2]);
        } else if (m.includes("\tERROR\tInvoke Error")) {
          errors += 1;
        } else {
          const rc = RECEIVE.exec(m);
          if (rc) maxReceiveCount = Math.max(maxReceiveCount ?? 0, Number(rc[1]));
        }
      }
      nextToken = res.nextToken;
      pages += 1;
    } while (nextToken && pages < 50);
    return { invocations, errors, billedMsSum, memoryMb: memoryMb || 512, maxReceiveCount };
  }
}
