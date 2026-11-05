# FinOps runbook: order-worker retry storm

Published in #finops-control as a room document by @burn-watchdog (source: `room/finops-runbook.md` in the BurnSwitch repo).

All commands run from the `scenario/` folder. `bin/aws-local` is the AWS CLI pointed at the demo's "production": LocalStack by default. If the scenario was started with `--real-aws`, it targets the real account and prints a ⚠️ REAL AWS banner on every call; then the queue URL and DLQ ARN below differ, so look them up first with `bin/aws-local sqs get-queue-url --queue-name orders` and `bin/aws-local sqs get-queue-attributes --queue-url <url of orders-dlq> --attribute-names QueueArn`. It refuses purge and delete commands. Every command marked **LIVE** changes production and needs jeevesh2605's approval in the room. Run it only after they ask, with one command per approval.

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

**3a. LIVE: pause the consumer.** Messages stay on the queue and nothing is lost.

```bash
bin/aws-local lambda put-function-concurrency --function-name order-worker --reserved-concurrent-executions 0
```

That's all containment is. **Don't attach the redrive policy yet.** SQS moves a message to the DLQ when it's received with a receive count above `maxReceiveCount`, whatever the code does with it. Good orders stuck in the storm already have counts of 10–100+, so a redrive policy attached now would dead-letter them all on the first poll after resuming.

## 4. Recover, in this order

| Step | What                            | Why this position                                                        |
| ---- | ------------------------------- | ------------------------------------------------------------------------ |
| 4a   | Patch + tests (local)           | The fix has to exist first                                               |
| 4b   | LIVE: deploy the patch          | While paused: nothing runs the old code again                            |
| 4c   | LIVE: ReportBatchItemFailures   | Bad orders now fail alone; good ones in their batch are kept             |
| 4d   | LIVE: resume processing         | Stuck good orders drain; bad ones fail fast (no retries, cheap)          |
| 4e   | LIVE: attach the redrive policy | Only after the backlog drained: only malformed orders are still retrying |

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

Then wait for the backlog to drain. This is read-only; repeat every 30 s until it says it's safe (usually 1–2 min):

```bash
bin/queue-check
```

Between 4d and 4e, malformed orders keep retrying without a DLQ. That's deliberate and cheap: with the patch and ReportBatchItemFailures they fail alone in about 1 ms each and stay on the queue, nothing is lost, and good orders are processed normally. Run 4e as soon as `bin/queue-check` says drained.

**4e. LIVE: attach the DLQ.** Malformed orders, now the only ones still retrying, move to `orders-dlq` on their next receive and stop costing anything.

```bash
bin/aws-local sqs set-queue-attributes --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/orders --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:000000000000:orders-dlq\",\"maxReceiveCount\":\"3\"}"}'
```

@burn-watchdog posts "resolved" once errors stay under 1% for 3 samples, and a final message count once traffic stops: every order sent must be processed, still queued, or in the DLQ, and the DLQ must hold only malformed orders.

## 5. After

- `orders-dlq` should hold only malformed `checkout-v2` orders. The watchdog's final count shows it (good orders in the DLQ: 0). If it ever shows good orders there, replaying them is a separate LIVE decision for jeevesh2605 (`sqs start-message-move-task`), not part of this runbook.
- Tell the upstream team (here, the `checkout-v2` client) about the payload change.
- The ledger (`cost-ledger.md`) has the timeline, every live change with the command and approval behind it, the cost and the message count.

## Never

- `purge-queue`, `delete-message`, `delete-queue` (`bin/aws-local` refuses these, and raw `aws` is denied).
- Attaching the redrive policy before the backlog of good orders has drained (step 4e comes last).
- Resuming before the patch and `ReportBatchItemFailures` are both in place.
- Changing production without an approval in this room. Every LIVE command prompts for approval each time: answer **Allow once**, never "Allow for this session".
