import { SQSClient, GetQueueUrlCommand } from "@aws-sdk/client-sqs";

try {
  process.loadEnvFile();
} catch {
  // No .env: fall back to LocalStack defaults below.
}

if (process.argv.includes("--real-aws")) {
  console.error("--real-aws is not supported yet (Phase 6). Refusing to touch real AWS.");
  process.exit(1);
}

export const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
});

export async function queueUrl(name: string): Promise<string> {
  const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!res.QueueUrl) throw new Error(`Queue ${name} not found. Run npm run scenario:up first.`);
  return res.QueueUrl;
}

export const STATE_DIR = new URL("../../.state/", import.meta.url);
export const PID_FILE = new URL("traffic.pid", STATE_DIR);
export const LOG_FILE = new URL("traffic.log", STATE_DIR);
