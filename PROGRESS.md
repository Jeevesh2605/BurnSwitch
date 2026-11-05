# BurnSwitch progress

## Ground rules

- [x] Switch docs MCP added (`switch-docs`, local scope); protocol, events, connection and operation catalog read
- [x] Agent protocol: WebSocket for events, HTTP for operations, act only on `payload.addressed`, answer pings (design rule, enforced from Phase 2)
- [x] TypeScript (Node 20.12+), npm, minimal dependencies
- [x] LocalStack by default; real AWS only behind `--real-aws` (enforced from Phase 1/6)
- [x] Never purge queues or delete messages (standing rule)
- [x] Secrets in `.env` only; `.env.example` added; `.env` ignored
- [ ] Lambda rates in `config/pricing.json` with a TODO for you (Phase 3)
- [x] PROGRESS.md maintained (you make the commits and tags yourself)

## Phase 0 — Scaffold

- [x] Repo, TypeScript config, ESLint + Prettier, `.env.example`, `.gitignore`, MIT license
- [x] `docker-compose.yml`: LocalStack (Docker socket mounted) + watchdog service
- [x] npm scripts: `scenario:up`, `scenario:reset`, `burn:start`, `burn:stop`, `watchdog:dev` (Phase 1/2 stubs for now)

## Phase 1 — The burning scenario (LocalStack)

- [x] `orders` queue, no redrive; `orders-dlq` exists but unwired (`scenario/infra/up.sh`)
- [x] `order-worker` Lambda with the intentional bug (throws on missing `items`, no partial batch failures)
- [x] `scenario/deploy-manifest.json` with fake deploy commit `8f3a1c`
- [ ] You: commit Phase 1 and run `git tag scenario-start` on that commit
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
- [ ] You: fill the two Lambda rates in `config/pricing.json` (watchdog refuses to start without them)
- [x] Detection with rolling baseline, one incident id, no duplicates (unit-tested)
- [x] Single handoff to @claude-code with loop guard (persisted before sending)
- [x] Containment + resolution messages (threaded under the alert)
- [ ] Record `watchdog/fixtures/storm.json` from a clean run
- [ ] **CHECKPOINT 3:** alert within ~1 min, exactly once

## Phase 4 — Ledger

- [ ] `cost-ledger.md` room document, created and updated live
- [ ] Approver fields (see notes: approvals are not in `read_context`)
- [ ] **CHECKPOINT 4**

## Phase 5 — Room material and agent instructions

- [ ] `room/instructions.md`
- [ ] `room/finops-runbook.md`
- [ ] `room/agents/claude-code.md`
- [ ] `room/agents/finops-auditor.md`
- [ ] `docs/setup.md`
- [ ] **CHECKPOINT 5**

## Phase 6 — Rehearsal and hardening

- [ ] `scripts/rehearse.sh`
- [ ] Watchdog restart / Switch disconnect / LocalStack restart
- [ ] `--real-aws` path with loud warning
- [ ] **CHECKPOINT 6**

## Phase 7 — Submission polish

- [ ] README, Mermaid architecture, quickstart, Switch feature map, video placeholder
- [ ] `docs/architecture.md`, troubleshooting

## Decisions

- Messaging app: **Telegram only** (one room maps to one app). Approval requests get inline Allow/Deny buttons; Switch polls Telegram, so nothing has to be publicly reachable.
- Local Switch server (run by Switch Console, switch-core 0.31.0): bridge `http://127.0.0.1:50556`, Gateway `http://127.0.0.1:50555`. Console can move ports on restart; the watchdog re-reads them from Console's `ports.json`.
- Room: `BurnSwitch: finops-control` (`77c411ba-1549-4057-9333-046be193408c`), Telegram group.
- LocalStack: auth token required; image pinned to `2026.10.0`.

## Notes from the Switch docs (verified 2026-11-04)

- Room documents can't be opened from Telegram; people see them via `!list-documents`, Switch Console or the Gateway.
- Addressing another agent: use `send_targeted_message` (`target_names`), not an `@name` inside `post_message`.
- `create_room_document` / `update_room_document` need a connection bound to the room (connection id header).
- Approval answers (`answered_by`) are stored server-side but no agent operation exposes them; `read_context` returns only messages and joins.
- Telegram: agent names don't autocomplete; type the name in full (`!list-agents` lists them). Group Privacy must be off in BotFather _before_ adding the bot.
- LocalStack ignores CloudWatch Logs `--filter-pattern`; filter log lines client-side.
- switch-core 0.31.0 refuses `update_agent_detail` from the agent itself (403), although the docs allow it. New agents already default to owner + owner's agents, so the watchdog keeps the default; @claude-code's addressing is set in Switch Console.
- `list_all_rooms` returns `room_id`, not `id`.
- The local server has no Gateway web page; registration keys come from `npm run switch:registration-key` (uses Switch Console's saved session, asks for Keychain access).
- LocalStack emits only Invocations/Errors metrics (no Duration/ConcurrentExecutions); the probe adapter derives duration from REPORT log lines.
