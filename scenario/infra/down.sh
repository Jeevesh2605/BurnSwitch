#!/usr/bin/env bash
# Takes the scenario down.
#   npm run scenario:down                 LocalStack: stops the container (its state is not kept)
#   npm run scenario:down -- --real-aws   real AWS: removes the mapping, Lambda, log group and
#                                         IAM role, after a typed confirmation
# It never deletes queues or messages (project rule). For real AWS it prints the two
# delete-queue commands so you can remove the queues yourself once you've checked them.
source "$(dirname "$0")/lib.sh" "$@"
cd "$ROOT"

if ! $REAL_AWS; then
  docker compose rm -sf localstack
  echo local >"$ROOT/.state/target" 2>/dev/null || true
  echo "LocalStack stopped. Its queues and messages went with it (state isn't persisted)."
  exit 0
fi

confirm_real_aws "REMOVE RESOURCES" "
  Removes: event source mapping, Lambda $FUNCTION, log group /aws/lambda/$FUNCTION,
           IAM role $ROLE. Keeps: queues $QUEUE and $DLQ, and every message in them."

UUID="$(mapping_uuid)"
if [[ "$UUID" != "None" ]]; then
  awsl lambda delete-event-source-mapping --uuid "$UUID" >/dev/null && echo "Removed mapping $UUID."
fi
awsl lambda delete-function --function-name "$FUNCTION" 2>/dev/null && echo "Removed Lambda $FUNCTION."
awsl logs delete-log-group --log-group-name "/aws/lambda/$FUNCTION" 2>/dev/null && echo "Removed its log group."
awsl iam detach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole 2>/dev/null || true
awsl iam delete-role --role-name "$ROLE" 2>/dev/null && echo "Removed IAM role $ROLE."
echo local >"$ROOT/.state/target"

cat <<MSG

Kept (never deleted by these scripts): queues $QUEUE and $DLQ with their messages.
Look at them first, then remove them yourself if you're done:
  aws sqs delete-queue --queue-url $(queue_url "$QUEUE" 2>/dev/null || echo "<orders queue url>")
  aws sqs delete-queue --queue-url $(queue_url "$DLQ" 2>/dev/null || echo "<orders-dlq queue url>")
MSG
