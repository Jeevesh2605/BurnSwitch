/** One look at order-worker over the last `windowS` seconds. Every adapter produces this. */
export interface Sample {
  at: string; // ISO time the sample was taken
  windowS: number;
  invocations: number;
  errors: number;
  billedMsSum: number; // sum of billed duration over the window
  memoryMb: number;
  maxReceiveCount: number | null; // highest SQS receive count seen; null if the source can't tell
  queueVisible: number;
  queueInFlight: number;
  dlqVisible: number;
  redriveConfigured: boolean;
  reservedConcurrency: number | null; // null = no reservation
}

export interface MetricsAdapter {
  readonly name: string;
  sample(): Promise<Sample>;
}
