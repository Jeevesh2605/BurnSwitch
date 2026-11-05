import { SQSClient, GetQueueUrlCommand } from "@aws-sdk/client-sqs";

try {
  process.loadEnvFile();
} catch {
  // No .env: fall back to LocalStack defaults below.
}

// LocalStack unless --real-aws. Real AWS drops the dummy LocalStack settings from .env and
// uses your normal credential chain (AWS_PROFILE, or REAL_AWS_PROFILE from .env).
export const realAws = process.argv.includes("--real-aws");
if (realAws) {
  delete process.env.AWS_ENDPOINT_URL;
  if (process.env.AWS_ACCESS_KEY_ID === "test") {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  }
  if (process.env.REAL_AWS_PROFILE) process.env.AWS_PROFILE = process.env.REAL_AWS_PROFILE;
  console.error(
    `⚠️  REAL AWS (region ${process.env.AWS_REGION ?? "us-east-1"}): orders go to your real queue and cost money.`,
  );
}

export const sqs = new SQSClient(
  realAws
    ? { region: process.env.AWS_REGION ?? "us-east-1" }
    : {
        region: process.env.AWS_REGION ?? "us-east-1",
        endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
        },
      },
);

export async function queueUrl(name: string): Promise<string> {
  const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!res.QueueUrl) throw new Error(`Queue ${name} not found. Run npm run scenario:up first.`);
  return res.QueueUrl;
}

export const STATE_DIR = new URL("../../.state/", import.meta.url);
export const PID_FILE = new URL("traffic.pid", STATE_DIR);
export const LOG_FILE = new URL("traffic.log", STATE_DIR);
