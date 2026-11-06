# BurnSwitch progress

## Ground rules

- [x] Switch docs MCP added (`switch-docs`, local scope); protocol, events, connection and operation catalog read
- [x] Agent protocol: WebSocket for events, HTTP for operations, act only on `payload.addressed`, answer pings (design rule, enforced from Phase 2)
- [x] TypeScript (Node 20.12+), npm, minimal dependencies
- [x] LocalStack by default; real AWS only behind `--real-aws` (enforced from Phase 1/6)
- [x] Never purge queues or delete messages (standing rule)
- [x] Secrets in `.env` only; `.env.example` added; `.env` ignored
- [x] Lambda rates in `config/pricing.json` (filled by you, checked 2026-11-04)
- [x] PROGRESS.md maintained (you make the commits and tags yourself)

## Phase 0 — Scaffold

- [x] Repo, TypeScript config, ESLint + Prettier, `.env.example`, `.gitignore`, MIT license
- [x] `docker-compose.yml`: LocalStack (Docker socket mounted) + watchdog service
- [x] npm scripts: `scenario:up`, `scenario:reset`, `burn:start`, `burn:stop`, `watchdog:dev` (Phase 1/2 stubs for now)

## Phase 1 — The burning scenario (LocalStack)

- [x] `orders` queue, no redrive; `orders-dlq` exists but unwired (`scenario/infra/up.sh`)
- [x] `order-worker` Lambda with the intentional bug (throws on missing `items`, no partial batch failures)
- [x] `scenario/deploy-manifest.json` with fake deploy commit `8f3a1c`
- [x] `scenario-start` tag created (now on the Phase 3 commit, buggy worker with `withRetry`)
- [x] `inject/`: normal traffic + N poison messages (`burn:start` / `burn:stop`)
- [x] `scenario:reset` (restores code from the tag; `--fresh` restarts LocalStack for empty queues)
- [x] `scenario:status` (`-- --watch`) to see the storm
- [x] **CHECKPOINT 1:** retry storm visible (2026-11-04: invocations 110→245/min, errors 10→226/min, 243 in flight, receive counts up to 26, DLQ empty) — approved

## Phase 2 — @burn-watchdog: connect to Switch

- [x] Registration script `npm run watchdog:register` (saves API key to .env at once, finds + joins the room) — done: agent `c7e20daf-5e61-4f50-a1a7-7a570b975b81`
- [x] WebSocket client (pings first, resume from cursor, backoff, stop on `taken_over`/`closed`, only `addressed` messages acted on)
- [x] HTTP ops helper + `POST /agents/{id}/message` (`npm run watchdog:hello`)
- [x] Bridge base URL verified with `GET /health`, falls back to Switch Console's `ports.json`
- [x] **CHECKPOINT 2:** "hello" visible in #finops-control — confirmed 2026-11-04 (hello visible; `burn-watchdog hi` gets a reply)

## Phase 3 — Metrics, cost model, detection

- [x] Metrics adapters: `cloudwatch`, `localstack-probe` (default; reads REPORT/ERROR log lines + SQS), `replay` (+ `npm run metrics:record`)
- [x] Cost model from `config/pricing.json` (requests + GB-seconds)
- [x] Lambda rates filled in `config/pricing.json` (us-east-1 x86: $0.20/M requests, $0.0000166667/GB-s)
- [x] Detection with rolling baseline, one incident id, no duplicates (unit-tested)
- [x] Single handoff to @claude-code with loop guard (persisted before sending)
- [x] Containment + resolution messages (threaded under the alert)
- [x] Record `watchdog/fixtures/storm.json` from a clean run (4 min, 16 samples; replay opens one incident at +45s)
- [x] Worker bug made costly: a generic `withRetry` (3 attempts, 1s/2s backoff) retries malformed orders too, so each poison attempt bills ~3s instead of ~3ms. Without it, burn stayed under baseline
- [x] Tag moved to the Phase 3 commit
- [x] **CHECKPOINT 3:** alert within ~1 min, exactly once — confirmed by you in Telegram 2026-11-05. 2026-11-05 run: burn:start 05:11:57Z, INC-20261105-0512-791f opened 05:12:55Z (58s), one incident, $0.009→$0.116/hr. Handoff to @claude-code failed (not in room yet) and the alert fell back to a room post

## Phase 4 — Ledger

- [x] `cost-ledger.md` room document (`watchdog/src/ledger/ledger.ts`): created on first connect, found again by name after a restart, recreated if deleted from the room UI
- [x] Contents: incident id, trigger commit, timeline, burn before/peak/after, estimated spend (and excess over baseline), actions taken, approvals, time to contain/resolve, DLQ count
- [x] Actions come from infra diffs the watchdog sees itself (`watchdog/src/incident/timeline.ts`): reserved concurrency, redrive policy, new code (CodeSha256), ReportBatchItemFailures, mapping state
- [x] Rewritten only when an incident changes: every document update also posts a "📄 updated room document" notice in the room, so no timer refresh
- [x] Approver fields: **TODO kept in the ledger.** Approvals (`answered_by`) are not readable by agents. The ledger records "Approved by <name>: <action>" lines posted in the room (by @claude-code, per Phase 5 instructions), with who reported each one
- [x] Unit tests: `watchdog/test/ledger.test.ts`
- [x] **CHECKPOINT 4:** ledger visible in the room and updates live — confirmed 2026-11-05 (`!list-documents` in Telegram lists it; `npm run ledger:show` prints it). 2026-11-05 run: created at start, updated 6 times (opened, concurrency 0, contained, redrive + unpause, resolved); time to contain 1m 15s, peak $0.100/hr (10.9×), 182 messages kept in the DLQ.
- Runbook note for Phase 5: adding redrive _without_ ReportBatchItemFailures dead-letters good orders that shared a batch with a poison one (182 in the DLQ in this run). Enable partial batch failures first, then redrive

## Phase 5 — Room material and agent instructions

- [x] `room/instructions.md` (paste into Console → room → Configuration → Instructions)
- [x] `room/finops-runbook.md`, published by the watchdog as the `finops-runbook.md` room document (attaching library documents needs the Gateway web page, which the local server lacks)
- [x] `room/agents/claude-code.md` (paste into the agent's **Agent instructions**)
- [x] `room/agents/finops-auditor.md`
- [x] `docs/setup.md` (Telegram only)
- [x] `scenario/bin/`: `aws-local` (LocalStack AWS CLI, refuses purge/delete), `repro` (handler in a node:22 container on `order-worker/repro/poison-batch.json`), `deploy-worker`
- [x] Scenario scripts load only `AWS_*` from `.env`, so @claude-code never holds the Switch key
- [x] **CHECKPOINT 5:** Console setup done and a full run with real approvals (2026-11-05, INC-20261105-0643-59c8):
  - alert 06:43:38 → @claude-code root cause in ~1 min, containment + patch + recovery proposed before any approval
  - 6 live changes, each approved in Telegram and recorded in the ledger from "Approved by" lines
  - contained 06:56:10, resolved 07:16:03; burn $0.115/hr peak → $0.006/hr; 773 messages kept in the DLQ
  - @finops-auditor joined late, wrote an accurate post-mortem, and flagged the two ledger rows without approvals (a LocalStack status glitch)
- [x] @claude-code's fix saved as `docs/reference/order-worker-fix.patch` (outside `scenario/`, so the agent can't see it); `scenario/order-worker` restored to the buggy version
- Lessons from the run:
  - Messages to agents must start with `@name` ("Run 3a" never reached @claude-code: 7 min lost). Added to the setup guide troubleshooting
  - Console agent **Directory**: pick it with **Choose…**. A typed path without the leading `/` silently fell back to `~/.switch/agents/...`, and editing it later doesn't move a running agent: delete and recreate
  - Agent instructions box: paste the full file. The first attempt saved the description text
  - LocalStack's `list-event-source-mappings` can report a stale `Disabled` after an update. The watchdog now reads state with `get-event-source-mapping`; the runbook checks it after 4c

## Phase 6 — Rehearsal and hardening

Acts (from the definition of done): 1 burn alert · 2 handoff + diagnosis · 3 containment (approved) · 4 fix + recovery (approved) · 5 resolved + ledger · 6 late auditor.

- [x] `npm run rehearse` (`scripts/rehearse.sh`): preflight → clean state → fresh scenario → watchdog → burn, then a cue per act, waiting for the watchdog to see each one. Works on macOS's bash 3.2
- [x] `npm run preflight` (`scripts/preflight.ts`): Docker (incl. paused), prices, Switch, who's in the room, room instructions vs `room/instructions.md`. Read-only
- [x] Watchdog restart mid-incident: resumes from `.state/`, and from the ledger if `.state/` is lost (the ledger carries the incident state in a hidden comment); it waits for that check before sampling, so no second alert
- [x] Switch disconnect: reconnect with backoff, re-reading Switch Console's ports (handles port moves); posts that can't be sent wait in an outbox (kept in the state file) and go out on reconnect; resume ticket is never wound back (fixes a replay gap after restarts)
- [x] LocalStack restart: one warning, sampling resumes when it's back, no crash
- [x] Resilience tests (dry-run watchdog with its own state, behind a TCP relay; nothing posted), 2026-11-05: all passed
  - one alert per incident; killed + restarted mid-incident → resumed, still one alert
  - LocalStack restarted mid-incident → outage logged once, sampling back after recreate
  - Switch cut while the incident was contained → update queued → Switch "back" on another port → found it, sent the update, outbox empty
- [x] `--real-aws`: `scenario:up/reset/status/down`, `burn:start/stop`, watchdog, `rehearse`. Shows the account + what it creates and needs the account id typed; ignores the dummy LocalStack keys; `bin/` helpers follow `.state/target` with a REAL AWS banner; `--fresh` refused with real AWS; queues never deleted (`scenario:down` prints the commands). Tested: the refusal path only (no resources created)
- [ ] You (optional): one real-AWS run with your credentials
- [ ] **CHECKPOINT 6:** `npm run rehearse`, Acts 1–6, no manual fixes

## Audit fixes (after the Checkpoint 6 run)

Flagged by @finops-auditor: unsigned changes, good orders in the DLQ, a 10-message gap.

- Causes found:
  - INC-0529's 3 changes: my scripted ledger test (`run4.sh`) called AWS directly. No agent, no approval
  - INC-0643's 2 mapping "flips": LocalStack's list call showing a stale status (only 2 UpdateEventSourceMapping calls in its log, both approved). Fixed in Phase 6 (direct get)
  - Good orders in the DLQ: SQS dead-letters on receive once the receive count exceeds maxReceiveCount, whatever the code does. Stuck good orders had counts of 10–120, so any redrive attached before they drained took them all (1,290 in the DLQ in the Checkpoint 6 run, ~1,000 good)
  - The 10-message gap: malformed orders from the verification traffic started at 07:15 reached the DLQ before the "resolved" snapshot (763 → 773). Also, the generator's own log never counted the 5-message burst
- [x] Every mutating AWS call by the scenario helpers is recorded in `.state/change-log.jsonl` with `source: agent` (bin/aws-local, bin/deploy-worker) or `source: setup` (scripts). The ledger shows each change with its command, source and paired approval; setup changes are listed separately; a change with no command is flagged "source unknown"
- [x] `scenario/.claude/settings.json`: `ask` on every live bin/ command (prompts every time, even after "Allow for this session"); `deny` raw `aws` and purge/delete
- [x] Runbook and @claude-code instructions: 3a pause only → 4b deploy → 4c ReportBatchItemFailures → 4d resume → `bin/queue-check` until the backlog drained → 4e redrive. (Redrive goes last, not before resuming: attached earlier it dead-letters the stuck good orders)
- [x] Exact traffic counts (`.state/traffic-stats.json`); reconciliation sent = processed + queued + DLQ, with the DLQ split into malformed/good once the queue is empty; snapshot at resolve, final count after traffic stops (ledger + reply under the alert)
- [x] @finops-auditor instructions: judge approvals per `source: agent` change; use the ledger's message count
- [ ] You: paste the updated `room/instructions.md` (room Configuration) and `room/agents/claude-code.md` + `finops-auditor.md` (each agent's instructions), then `!reset` both agents
- [ ] You: a full clean run (`npm run rehearse`) and the auditor's report

## Audit fixes, rounds 2–3 (after the INC-1438 and INC-0348 runs)

- [x] One incident at a time: a rehearsal closes an open incident as **abandoned** (kept in the ledger). A pause before the alert is recorded as "contained before alert". Approvals and requests that arrive before the incident opens are held for 10 min.
- [x] Time to contain = alert → the containment command's timestamp, in the ledger and in the contained and resolved messages.
- [x] Cost avoided = (peak − baseline) × `cost.unnoticed_hours` (8 h, in `config/thresholds.json`), with the assumption stated. The "after" burn is measured only once the backlog has drained.
- [x] `npm run demo:reset [-- --room "<group>"]`: archives the state, deletes cost-ledger.md, switches room (agents and instructions), recreates LocalStack. An exact group-name match wins (every Telegram room is named "BurnSwitch: <group>").
- [x] Attribution race (INC-0348's 4c showed "source unknown"): a sample can see a change before `bin/aws-local` has logged it. Unknown changes are retried for 2 min.
- [x] Each change is paired with jeevesh2605's "run …" message (same kind, up to 2 min before), as well as the approval line. Runbook step ids map to change kinds from the runbook headings.
- [x] Recovery order, as requested: 4b deploy → 4c ReportBatchItemFailures → 4d redrive → 4e `bin/recovery-check`, then resume → 4f move the DLQ back (`sqs start-message-move-task`). `bin/aws-local` refuses to restore concurrency until the redrive policy (orders-dlq, maxReceiveCount 3) and ReportBatchItemFailures are verified. 4f is needed because resuming with redrive dead-letters the stuck good orders (receive counts above 3); moved messages restart at receive count 0.
- [x] Verified end to end on LocalStack (dry-run watchdog, steps run through bin/ helpers), 2026-11-06:
  - the resume was refused while anything was missing;
  - 203 good orders went to the DLQ on resume, and 4f brought them back;
  - final count: 747 sent (609 + 138) = 609 processed + 0 queued + 138 in the DLQ (138 malformed, 0 good) ✓;
  - all 6 changes were attributed as `source: agent`.

## Phase 7 — Submission polish

- [ ] README, Mermaid architecture, quickstart, Switch feature map, video placeholder
- [ ] `docs/architecture.md`, troubleshooting

## Decisions

- Messaging app: **Telegram only** (one room maps to one app). Approval requests get inline Allow/Deny buttons; Switch polls Telegram, so nothing has to be publicly reachable.
- Local Switch server (run by Switch Console, switch-core 0.31.0): bridge `http://127.0.0.1:50556`, Gateway `http://127.0.0.1:50555`. Console can move ports on restart; the watchdog re-reads them from Console's `ports.json`.
- Room: `BurnSwitch: BurnSwitch` (`3e5be04f…`, the recording room) since 2026-11-06; previously `BurnSwitch: finops-control` (`77c411ba…`).
- LocalStack: auth token required; image pinned to `2026.10.0`.

## Notes from the Switch docs (verified 2026-11-04)

- Room documents can't be opened from Telegram, and Switch Console (v0.40.1) doesn't show a Telegram room's chat. Read the ledger with `npm run ledger:show` (Console's room Configuration tab doesn't list documents); `!list-documents` in Telegram lists it.
- Every `create_room_document` / `update_room_document` posts a "📄 created/updated room document" notice in the room (switch-core 0.31.0, not configurable). Document names are unique per room.
- Addressing another agent: use `send_targeted_message` (`target_names`), not an `@name` inside `post_message`.
- `create_room_document` / `update_room_document` need a connection bound to the room (connection id header).
- Approval answers (`answered_by`) are stored server-side but no agent operation exposes them; `read_context` returns only messages and joins.
- Telegram: agent names don't autocomplete; type the name in full (`!list-agents` lists them). Group Privacy must be off in BotFather _before_ adding the bot.
- LocalStack ignores CloudWatch Logs `--filter-pattern`; filter log lines client-side.
- switch-core 0.31.0 refuses `update_agent_detail` from the agent itself (403), although the docs allow it. New agents already default to owner + owner's agents, so the watchdog keeps the default; @claude-code's addressing is set in Switch Console.
- `list_all_rooms` returns `room_id`, not `id`.
- The local server has no Gateway web page; registration keys come from `npm run switch:registration-key` (uses Switch Console's saved session, asks for Keychain access).
- LocalStack emits only Invocations/Errors metrics (no Duration/ConcurrentExecutions); the probe adapter derives duration from REPORT log lines.
