#!/usr/bin/env bash
# Shared settings for the scenario scripts.
#
# Target: LocalStack by default. Real AWS only with --real-aws on the command, or, for the
# bin/ helpers @claude-code runs, when .state/target says "real" (written by
# `scenario:up -- --real-aws`). Real AWS prints a banner on every command.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_FILE="$ROOT/.state/target"

# Only the AWS_* settings from .env: these scripts are also run by @claude-code, which has
# no business holding the Switch API key. (docker compose reads .env by itself.)
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line; do export "${line?}"; done < <(grep -E '^(AWS_[A-Z_]+|REAL_AWS_PROFILE)=' "$ROOT/.env")
fi

REAL_AWS=false
for arg in "$@"; do [[ "$arg" == "--real-aws" ]] && REAL_AWS=true; done
if [[ "${BURNSWITCH_FOLLOW_TARGET:-}" == "1" && -f "$TARGET_FILE" && "$(cat "$TARGET_FILE")" == "real" ]]; then
  REAL_AWS=true
fi

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""

FUNCTION=order-worker
QUEUE=orders
DLQ=orders-dlq
ROLE=order-worker-role
MEMORY_MB=512
TIMEOUT_S=5
BATCH_SIZE=10
WORKER_DIR="$ROOT/scenario/order-worker"

if $REAL_AWS; then
  # The dummy LocalStack settings from .env must not leak into real calls.
  unset AWS_ENDPOINT_URL
  if [[ "${AWS_ACCESS_KEY_ID:-}" == "test" ]]; then unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; fi
  if [[ -n "${REAL_AWS_PROFILE:-}" ]]; then export AWS_PROFILE="$REAL_AWS_PROFILE"; fi
  awsl() { aws "$@"; }
  if ! ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"; then
    echo "--real-aws: no working AWS credentials. Set AWS_PROFILE / REAL_AWS_PROFILE or run aws configure." >&2
    exit 1
  fi
  echo "⚠️  REAL AWS: account $ACCOUNT, region $AWS_REGION${AWS_PROFILE:+, profile $AWS_PROFILE}" >&2
else
  export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
  export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
  ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
  awsl() { aws --endpoint-url "$ENDPOINT" "$@"; }
fi

# Loud warning plus a typed confirmation before anything is created in (or removed from) a
# real account. BURNSWITCH_CONFIRM=<account id> skips the prompt (for scripts).
confirm_real_aws() {
  $REAL_AWS || return 0
  cat >&2 <<EOF

================================================================================
  ⚠️  YOU ARE ABOUT TO $1 IN A REAL AWS ACCOUNT
      Account $ACCOUNT · region $AWS_REGION${AWS_PROFILE:+ · profile $AWS_PROFILE}
$2
  This can cost money. The demo traffic is small (cents per run), but a storm
  left running keeps billing until you run: npm run burn:stop
================================================================================
EOF
  if [[ "${BURNSWITCH_CONFIRM:-}" == "$ACCOUNT" ]]; then return 0; fi
  read -r -p "Type the account id ($ACCOUNT) to continue: " answer
  [[ "$answer" == "$ACCOUNT" ]] || { echo "Not confirmed. Nothing was changed." >&2; exit 1; }
}

wait_for_localstack() {
  $REAL_AWS && return 0
  echo "Waiting for LocalStack at $ENDPOINT ..."
  for _ in $(seq 1 60); do
    if curl -sf "$ENDPOINT/_localstack/health" >/dev/null; then echo "LocalStack is up."; return 0; fi
    sleep 2
  done
  echo "LocalStack did not become healthy. Check: docker compose logs localstack" >&2
  exit 1
}

queue_url() { awsl sqs get-queue-url --queue-name "$1" --query QueueUrl --output text; }
queue_arn() {
  awsl sqs get-queue-attributes --queue-url "$(queue_url "$1")" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text
}

build_worker() {
  echo "Building $FUNCTION ..."
  rm -rf "$WORKER_DIR/dist"
  (cd "$ROOT" && npx tsc -p scenario/order-worker/tsconfig.json)
  echo '{"type":"module"}' >"$WORKER_DIR/dist/package.json"
  (cd "$WORKER_DIR/dist" && rm -f ../function.zip && zip -qr ../function.zip .)
}

role_arn() {
  if $REAL_AWS; then echo "arn:aws:iam::$ACCOUNT:role/$ROLE"; else echo "arn:aws:iam::000000000000:role/$ROLE"; fi
}

ensure_role() {
  if awsl iam get-role --role-name "$ROLE" >/dev/null 2>&1; then return 0; fi
  awsl iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    >/dev/null
  if $REAL_AWS; then
    # Read from SQS + write logs: the AWS-managed policy made for exactly this.
    awsl iam attach-role-policy --role-name "$ROLE" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole
    echo "Created IAM role $ROLE; waiting 10s for it to propagate ..."
    sleep 10
  fi
}

deploy_worker() {
  build_worker
  if awsl lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
    awsl lambda update-function-code --function-name "$FUNCTION" \
      --zip-file "fileb://$WORKER_DIR/function.zip" >/dev/null
    awsl lambda wait function-updated-v2 --function-name "$FUNCTION"
    echo "Updated $FUNCTION code."
  else
    ensure_role
    awsl lambda create-function --function-name "$FUNCTION" \
      --runtime nodejs22.x --handler handler.handler \
      --memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" \
      --role "$(role_arn)" \
      --zip-file "fileb://$WORKER_DIR/function.zip" >/dev/null
    awsl lambda wait function-active-v2 --function-name "$FUNCTION"
    echo "Created $FUNCTION."
  fi
}

mapping_uuid() {
  awsl lambda list-event-source-mappings --function-name "$FUNCTION" \
    --query 'EventSourceMappings[0].UUID' --output text
}
