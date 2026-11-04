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
- [ ] **CHECKPOINT 1:** retry storm visible

## Phase 2 — @burn-watchdog: connect to Switch

- [ ] Registration script (save API key once, set addressing)
- [ ] WebSocket client (pings, reconnect with backoff, ignore unaddressed)
- [ ] HTTP ops helper + `POST /agents/{id}/message`
- [ ] Verify bridge base URL with `GET /health`
- [ ] **CHECKPOINT 2:** "hello" visible in #finops-control

## Phase 3 — Metrics, cost model, detection

- [ ] Metrics adapters: `cloudwatch`, `localstack-probe`, `replay`
- [ ] Cost model from `config/pricing.json`
- [ ] Detection with rolling baseline, one incident id, no duplicates
- [ ] Single handoff to @claude-code with loop guard
- [ ] Recovery detection + resolution message
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

## Notes from the Switch docs (verified 2026-11-04)

- Room documents can't be opened from Mattermost/Telegram; people see them via `!list-documents`, Switch Console or the Gateway.
- Addressing another agent: use `send_targeted_message` (`target_names`), not an `@name` inside `post_message`.
- `create_room_document` / `update_room_document` need a connection bound to the room (connection id header).
- Approval answers (`answered_by`) are stored server-side but no agent operation exposes them; `read_context` returns only messages and joins.
