#!/usr/bin/env bash
# Creates the "production" system in LocalStack:
#   orders queue (no redrive policy), orders-dlq (exists, not wired up),
#   order-worker Lambda, and the event source mapping between them.
# Safe to run more than once.
#   npm run scenario:up                 LocalStack (default)
#   npm run scenario:up -- --real-aws   your real AWS account, after a typed confirmation
source "$(dirname "$0")/lib.sh" "$@"

cd "$ROOT"
confirm_real_aws "CREATE RESOURCES" "
  Creates: SQS queues $QUEUE + $DLQ, Lambda $FUNCTION (${MEMORY_MB} MB, nodejs22.x),
           IAM role $ROLE (AWSLambdaSQSQueueExecutionRole), and the event
           source mapping $QUEUE -> $FUNCTION (batch $BATCH_SIZE, no redrive: the bug)."
if ! $REAL_AWS && ! curl -sf "$ENDPOINT/_localstack/health" >/dev/null; then
  docker compose up -d localstack
fi
wait_for_localstack

# Short visibility timeout so failed batches come back fast: that is the retry storm.
awsl sqs create-queue --queue-name "$QUEUE" \
  --attributes "VisibilityTimeout=$TIMEOUT_S,MessageRetentionPeriod=345600" >/dev/null
awsl sqs create-queue --queue-name "$DLQ" \
  --attributes "MessageRetentionPeriod=1209600" >/dev/null
echo "Queues ready: $QUEUE (no redrive policy), $DLQ (not wired up)."

deploy_worker

if [[ "$(mapping_uuid)" == "None" ]]; then
  # No FunctionResponseTypes: one bad record fails (and retries) the whole batch.
  awsl lambda create-event-source-mapping --function-name "$FUNCTION" \
    --event-source-arn "$(queue_arn "$QUEUE")" --batch-size "$BATCH_SIZE" \
    --maximum-batching-window-in-seconds 0 >/dev/null
  echo "Event source mapping created ($QUEUE -> $FUNCTION, batch size $BATCH_SIZE)."
else
  echo "Event source mapping already exists ($(mapping_uuid))."
fi

# The bin/ helpers @claude-code runs follow this file, so they act where the scenario lives.
mkdir -p "$ROOT/.state"
if $REAL_AWS; then echo real >"$ROOT/.state/target"; else echo local >"$ROOT/.state/target"; fi

echo
echo "Scenario is up ($(cat "$ROOT/.state/target")). Next: npm run burn:start, then npm run scenario:status -- --watch"
