// CloudWatch metrics (real AWS, or LocalStack if it ever emits Duration).
// Receive counts aren't a CloudWatch metric, so maxReceiveCount is null here.
import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { GetFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { aws } from "../aws.js";
import { readInfra } from "./queues.js";
import type { MetricsAdapter, Sample } from "./types.js";

export class CloudWatchAdapter implements MetricsAdapter {
  readonly name = "cloudwatch";
  private memoryMb?: number;

  constructor(
    private readonly fn: string,
    private readonly queue: string,
    private readonly dlq: string,
    private readonly windowS: number,
  ) {}

  async sample(): Promise<Sample> {
    const end = new Date();
    const start = new Date(end.getTime() - this.windowS * 1000);
    const metric = (id: string, name: string, stat: string) => ({
      Id: id,
      MetricStat: {
        Metric: {
          Namespace: "AWS/Lambda",
          MetricName: name,
          Dimensions: [{ Name: "FunctionName", Value: this.fn }],
        },
        Period: this.windowS,
        Stat: stat,
      },
    });
    const [data, infra] = await Promise.all([
      aws.cloudwatch.send(
        new GetMetricDataCommand({
          StartTime: start,
          EndTime: end,
          MetricDataQueries: [
            metric("inv", "Invocations", "Sum"),
            metric("err", "Errors", "Sum"),
            metric("dur", "Duration", "Average"),
          ],
        }),
      ),
      readInfra(this.fn, this.queue, this.dlq),
    ]);
    const sum = (id: string) =>
      (data.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []).reduce((a, b) => a + b, 0);
    this.memoryMb ??=
      (await aws.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: this.fn })))
        .MemorySize ?? 128;
    const invocations = sum("inv");
    return {
      at: end.toISOString(),
      windowS: this.windowS,
      invocations,
      errors: sum("err"),
      billedMsSum: Math.ceil(sum("dur")) * invocations,
      memoryMb: this.memoryMb,
      maxReceiveCount: null,
      ...infra,
    };
  }
}
