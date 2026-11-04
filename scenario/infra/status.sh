#!/usr/bin/env bash
# Shows whether the retry storm is happening: queue depth, in-flight messages,
# Lambda invocations/errors per minute, and recent handler errors.
#   npm run scenario:status            one snapshot
#   npm run scenario:status -- --watch refresh every 10s
source "$(dirname "$0")/lib.sh" "$@"

WATCH=false
for arg in "$@"; do [[ "$arg" == "--watch" ]] && WATCH=true; done

metric_per_minute() {
  local name="$1" start end
  start="$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-5 min' +%Y-%m-%dT%H:%M:%SZ)"
  end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  awsl cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name "$name" \
    --dimensions "Name=FunctionName,Value=$FUNCTION" --statistics Sum --period 60 \
    --start-time "$start" --end-time "$end" \
    --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text 2>/dev/null \
    | awk '{ printf "    %s  %s\n", substr($1,12,5), $2 }'
}

snapshot() {
  echo "=== $(date '+%H:%M:%S')  BurnSwitch scenario status ==="
  for q in "$QUEUE" "$DLQ"; do
    awsl sqs get-queue-attributes --queue-url "$(queue_url "$q")" \
      --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible RedrivePolicy \
      --query 'Attributes' --output json \
      | jq -r --arg q "$q" '"  \($q): visible=\(.ApproximateNumberOfMessages) in_flight=\(.ApproximateNumberOfMessagesNotVisible) redrive=\(.RedrivePolicy // "none")"'
  done
  local conc
  conc="$(awsl lambda get-function-concurrency --function-name "$FUNCTION" \
    --query ReservedConcurrentExecutions --output text 2>/dev/null || echo None)"
  echo "  $FUNCTION reserved concurrency: $conc"
  echo "  Invocations per minute (UTC):"; metric_per_minute Invocations
  echo "  Errors per minute (UTC):";      metric_per_minute Errors
  echo "  Handler errors in the last 2 min:"
  local since=$(( ($(date +%s) - 120) * 1000 ))
  awsl logs filter-log-events --log-group-name "/aws/lambda/$FUNCTION" --start-time "$since" \
    --filter-pattern '"ERROR"' --query 'length(events)' --output text 2>/dev/null \
    | sed 's/^/    /' || echo "    (no log group yet)"
}

if $WATCH; then
  while true; do clear; snapshot; sleep 10; done
else
  snapshot
fi
