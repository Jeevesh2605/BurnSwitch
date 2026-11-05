#!/usr/bin/env bash
# Shared settings for the scenario scripts. LocalStack only; real AWS lands in Phase 6.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Only the AWS_* settings from .env: these scripts are also run by @claude-code, which has
# no business holding the Switch API key. (docker compose reads .env by itself.)
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line; do export "${line?}"; done < <(grep -E '^AWS_[A-Z_]+=' "$ROOT/.env")
fi

for arg in "$@"; do
  if [[ "$arg" == "--real-aws" ]]; then
    echo "--real-aws is not supported yet (Phase 6). Refusing to touch real AWS." >&2
    exit 1
  fi
done

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_PAGER=""
ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"

FUNCTION=order-worker
QUEUE=orders
DLQ=orders-dlq
MEMORY_MB=512
TIMEOUT_S=5
BATCH_SIZE=10
WORKER_DIR="$ROOT/scenario/order-worker"

awsl() { aws --endpoint-url "$ENDPOINT" "$@"; }

wait_for_localstack() {
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

deploy_worker() {
  build_worker
  if awsl lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
    awsl lambda update-function-code --function-name "$FUNCTION" \
      --zip-file "fileb://$WORKER_DIR/function.zip" >/dev/null
    awsl lambda wait function-updated-v2 --function-name "$FUNCTION"
    echo "Updated $FUNCTION code."
  else
    awsl iam create-role --role-name order-worker-role \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
      >/dev/null 2>&1 || true
    awsl lambda create-function --function-name "$FUNCTION" \
      --runtime nodejs22.x --handler handler.handler \
      --memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" \
      --role arn:aws:iam::000000000000:role/order-worker-role \
      --zip-file "fileb://$WORKER_DIR/function.zip" >/dev/null
    awsl lambda wait function-active-v2 --function-name "$FUNCTION"
    echo "Created $FUNCTION."
  fi
}

mapping_uuid() {
  awsl lambda list-event-source-mappings --function-name "$FUNCTION" \
    --query 'EventSourceMappings[0].UUID' --output text
}
