#!/usr/bin/env bash
# Puts the scenario back to its starting (buggy) state so the demo can be re-recorded.
#   - restores scenario/order-worker from the `scenario-start` git tag (if the tag exists)
#   - removes any redrive policy and reserved concurrency, re-enables the mapping
#   - redeploys the buggy handler
# It never purges queues or deletes messages. To start from empty queues, use --fresh,
# which restarts the LocalStack container (its state is not persisted, so it starts empty).
source "$(dirname "$0")/lib.sh" "$@"
cd "$ROOT"

FRESH=false
for arg in "$@"; do [[ "$arg" == "--fresh" ]] && FRESH=true; done
if $FRESH && $REAL_AWS; then
  echo "--fresh restarts LocalStack; it can't be used with --real-aws (nothing is ever purged)." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/scenario-start" >/dev/null; then
  echo "Restoring scenario/order-worker from tag scenario-start (local edits there are overwritten)."
  git checkout scenario-start -- scenario/order-worker/src scenario/order-worker/test
  git clean -fdq scenario/order-worker/src scenario/order-worker/test
else
  echo "WARNING: git tag scenario-start not found; keeping the current handler code." >&2
  echo "         Create it on the buggy commit: git tag scenario-start <commit>" >&2
fi

if $FRESH; then
  echo "Restarting LocalStack for a clean emulator state ..."
  docker compose rm -sf localstack
  docker compose up -d localstack
  exec "$ROOT/scenario/infra/up.sh"
fi

wait_for_localstack
ORDERS_URL="$(queue_url "$QUEUE")"
awsl sqs set-queue-attributes --queue-url "$ORDERS_URL" --attributes RedrivePolicy=""
awsl sqs set-queue-attributes --queue-url "$ORDERS_URL" --attributes "VisibilityTimeout=$TIMEOUT_S"
awsl lambda delete-function-concurrency --function-name "$FUNCTION" 2>/dev/null || true
awsl lambda update-function-configuration --function-name "$FUNCTION" \
  --memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" >/dev/null
awsl lambda wait function-updated-v2 --function-name "$FUNCTION"
deploy_worker

UUID="$(mapping_uuid)"
if [[ "$UUID" != "None" ]]; then
  awsl lambda update-event-source-mapping --uuid "$UUID" --enabled \
    --function-response-types '[]' --batch-size "$BATCH_SIZE" >/dev/null
fi
echo "Reset done: no redrive policy, no reserved concurrency, buggy handler deployed."
echo "Messages already in $QUEUE / $DLQ were left alone (use --fresh for empty queues)."
