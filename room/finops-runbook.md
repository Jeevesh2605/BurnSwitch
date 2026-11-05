# FinOps runbook: order-worker retry storm

Published in #finops-control as a room document by @burn-watchdog (source: `room/finops-runbook.md` in the BurnSwitch repo).

All commands run from the `scenario/` folder. `bin/aws-local` is the AWS CLI pointed at the demo's LocalStack "production". It refuses purge and delete commands. Every command marked **LIVE** changes production and needs jeevesh2605's approval in the room. Run it only after they ask, with one command per approval.

## 1. What the alert means

@burn-watchdog samples order-worker every 15 s over a 60 s window and prices it with Lambda's request and GB-second rates. It opens one incident (`INC-…`) when all of these hold for 2 samples in a row:

| Signal            | Threshold                                                       |
| ----------------- | --------------------------------------------------------------- |
| Burn ($/hr)       | ≥ 1.5× the healthy baseline (rolling median of healthy samples) |
| Error rate        | ≥ 5% of invocations                                             |
| SQS receive count | ≥ 3 (messages are being retried)                                |

**Contained**: no invocations for 3 samples (for example, reserved concurrency 0).
**Resolved**: processing again with < 1% errors for 3 samples.

Typical cause: a message the worker can't process. Without a redrive policy, it's retried forever, and without partial batch failure reporting, the whole batch is retried with it.

## 2. Investigate (no approval needed: read-only or local)

```bash
bin/aws-local sqs get-queue-attributes --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/orders --attribute-names All
bin/aws-local lambda get-function-concurrency --function-name order-worker
bin/aws-local lambda list-event-source-mappings --function-name order-worker
bin/aws-local logs filter-log-events --log-group-name /aws/lambda/order-worker --limit 50
bin/repro                         # runs the handler on a recorded batch in a node:22 container
(cd order-worker && npx tsx --test test/*.test.ts)
```

Check `deploy-manifest.json` for the suspect deploy.

## 3. Contain: stop the burn, keep every message

Propose both commands together, then run each one after approval.

**3a. LIVE: pause the consumer.** Messages stay on the queue and nothing is lost.

```bash
bin/aws-local lambda put-function-concurrency --function-name order-worker --reserved-concurrent-executions 0
```

**3b. LIVE: attach the DLQ** so that, once processing restarts, a message that fails 3 times is kept in `orders-dlq` instead of retrying forever.

```bash
bin/aws-local sqs set-queue-attributes --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/orders --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:000000000000:orders-dlq\",\"maxReceiveCount\":\"3\"}"}'
```

⚠️ Keep concurrency at 0 until step 4 is fully done. With the redrive on, the old code fails whole batches, so good orders that share a batch with a bad one would also end up in the DLQ.

## 4. Recover: fix, then resume

**4a. Patch (local).**

- Validate the payload before pricing.
- Don't retry validation errors: they will never succeed.
- Return `{ batchItemFailures: [{ itemIdentifier: messageId }] }` so only the bad messages are retried.
- Add a test with a malformed order. Run the tests and `bin/repro`, then post the output and a short diff summary.

**4b. LIVE: deploy the patch.**

```bash
bin/deploy-worker
```

**4c. LIVE: turn on partial batch failure reporting.** Look up the UUID first; this is read-only.

```bash
bin/aws-local lambda list-event-source-mappings --function-name order-worker --query 'EventSourceMappings[0].UUID' --output text
bin/aws-local lambda update-event-source-mapping --uuid <UUID> --function-response-types ReportBatchItemFailures
```

Then check the mapping is still **Enabled**, with a direct read (LocalStack's list command can show a stale "Disabled" for a minute after an update):

```bash
bin/aws-local lambda get-event-source-mapping --uuid <UUID> --query State
```

**4d. LIVE: resume processing.**

```bash
bin/aws-local lambda delete-function-concurrency --function-name order-worker
```

@burn-watchdog posts "resolved" once errors stay under 1% for 3 samples.

## 5. After

- Messages that already had more than 3 receives when processing resumed go straight to `orders-dlq`, including good orders that were stuck behind a bad one. They are kept, not lost. Replaying them is a separate decision for jeevesh2605 and is not part of this runbook.
- Tell the upstream team (here, the `checkout-v2` client) about the payload change.
- The ledger (`cost-ledger.md`) has the timeline, the cost and the approvals for the post-mortem.

## Never

- `purge-queue`, `delete-message`, `delete-queue` (`bin/aws-local` refuses these anyway).
- Resuming before the patch and `ReportBatchItemFailures` are both in place.
- Changing production without an approval in this room.
