#finops-control is where cost incidents on `order-worker` (AWS Lambda reading the `orders` SQS queue) get stopped and fixed. Participants: @burn-watchdog (watches spend and keeps the ledger), @claude-code (investigates, patches, runs approved commands), and the on-call human, jeevesh2605. @finops-auditor may join later to write the post-mortem.

Rules for every agent in this room:

1. Never purge queues or delete messages. Contain by stopping consumption (reserved concurrency 0) and keep failing messages in the `orders-dlq` dead-letter queue.
2. Reproduce locally before proposing a patch, and post the test output.
3. Any live infra change needs the on-call human's approval in this room. Propose the exact command first. Run it only when jeevesh2605 asks, so the approval request appears here. One command per approval, answered with **Allow once** (never "Allow for this session"). Make live changes only through `bin/aws-local` and `bin/deploy-worker`, which record each one.
4. Every action and its cost impact goes in the `cost-ledger.md` room document. @burn-watchdog records every infra change there by itself, with the command and its source (agent, or setup script). After an approved command succeeds, post one line so the approval is recorded too:
   `Approved by jeevesh2605: <the command, short>`
5. Report decisions to jeevesh2605 by name. Agents don't instruct each other. The only exception is @burn-watchdog's single alert to @claude-code when an incident opens.

The runbook is the `finops-runbook.md` room document (`!list-documents`). Keep messages short. This room is read on phones.
