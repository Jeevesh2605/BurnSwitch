import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";

// LocalStack unless --real-aws (Phase 6). The dummy credentials only work against LocalStack.
export const realAws = process.argv.includes("--real-aws");
if (realAws) {
  throw new Error("--real-aws is not supported yet (Phase 6). Refusing to touch real AWS.");
}

const config = {
  region: process.env.AWS_REGION ?? "us-east-1",
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
