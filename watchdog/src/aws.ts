import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";

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
}

const region = process.env.AWS_REGION ?? "us-east-1";
const config = realAws
  ? { region }
  : {
      region,
      endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    };

export const aws = {
  sqs: new SQSClient(config),
  lambda: new LambdaClient(config),
  logs: new CloudWatchLogsClient(config),
  cloudwatch: new CloudWatchClient(config),
};
