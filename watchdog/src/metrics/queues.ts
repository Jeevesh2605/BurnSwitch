import { GetFunctionConcurrencyCommand } from "@aws-sdk/client-lambda";
import { GetQueueAttributesCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { aws } from "../aws.js";

const urls = new Map<string, string>();
async function queueUrl(name: string): Promise<string> {
  const cached = urls.get(name);
  if (cached) return cached;
  const res = await aws.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  urls.set(name, res.QueueUrl!);
  return res.QueueUrl!;
}

/** Queue depth, redrive and concurrency: read-only calls shared by the live adapters. */
export async function readInfra(fn: string, queue: string, dlq: string) {
  const attrs = async (name: string) =>
    (
      await aws.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: await queueUrl(name),
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
            "RedrivePolicy",
          ],
        }),
      )
    ).Attributes ?? {};
  const [q, d, conc] = await Promise.all([
    attrs(queue),
    attrs(dlq),
    aws.lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: fn })),
  ]);
  return {
    queueVisible: Number(q.ApproximateNumberOfMessages ?? 0),
    queueInFlight: Number(q.ApproximateNumberOfMessagesNotVisible ?? 0),
    dlqVisible: Number(d.ApproximateNumberOfMessages ?? 0),
    redriveConfigured: Boolean(q.RedrivePolicy),
    reservedConcurrency: conc.ReservedConcurrentExecutions ?? null,
  };
}
