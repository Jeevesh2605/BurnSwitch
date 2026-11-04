// Minimal SQS event types, so the function has no runtime dependencies.
export interface SQSRecord {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: { ApproximateReceiveCount: string; [key: string]: string };
  eventSourceARN: string;
}

export interface SQSEvent {
  Records: SQSRecord[];
}

export interface SQSBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}
