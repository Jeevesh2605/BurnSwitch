# Setting up the #finops-control room

This guide is for the person running the BurnSwitch demo: you, the on-call human. It covers a local Switch server run by Switch Console, with the room bridged to a Telegram group. Wherever this guide says `jeevesh2605`, use your own Telegram username, and set it as `ONCALL_NAME` in `.env`.

The finished room has:

| Who             | What it does                                                                                        | Runs where                         |
| --------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------- |
| @burn-watchdog  | Watches spend, raises one alert per incident, keeps `cost-ledger.md`, publishes `finops-runbook.md` | This repo (`npm run watchdog:dev`) |
| @claude-code    | Investigates, patches, runs approved commands                                                       | Switch Console, in `scenario/`     |
| you             | Approve or decline each live change                                                                 | Telegram                           |
| @finops-auditor | Joins at the end, writes the post-mortem                                                            | Switch Console                     |

## 0. Before you start

- Docker Desktop running (and not paused), with `LOCALSTACK_AUTH_TOKEN` in `.env`.
- Switch Console installed and signed in, with **Local Switch server** running (green dot).
- The AWS CLI v2 (`aws --version`) and Node 20+.
- Claude Code installed and signed in on this computer. Switch Console dims the provider otherwise.

## 1. The room, bridged to Telegram

1. In Telegram, create a bot with **@BotFather** (`/newbot`). Then, in BotFather, go to **Bot Settings → Group Privacy → Turn off**. Do this **before** adding the bot to a group.
2. In Switch Console, go to **Connectors → Telegram**, paste the bot token, and connect.
3. Create a Telegram group called `finops-control` and add the bot. Switch creates the room (`BurnSwitch: finops-control`).
4. In Switch Console, go to **Connectors → Telegram → ⋮ → Link my account…** so that your Telegram messages count as you.
   - If it says "Bridge is not running", use **⋮ → Disconnect app…** and connect again with the same token.

## 2. Room instructions

Switch Console → **Your Rooms → finops-control → Configuration → Instructions**: paste all of [`room/instructions.md`](../room/instructions.md), then **Save**. Every agent reads these when it joins.

## 3. @burn-watchdog

```bash
npm run switch:registration-key   # once: creates a registration key (asks for Keychain access)
npm run watchdog:register         # once: registers the agent, saves its key to .env, joins the room
npm run watchdog:dev              # keep this running
```

When it connects, it publishes two room documents. Check them in Telegram with `!list-documents`:

- `finops-runbook.md`, from [`room/finops-runbook.md`](../room/finops-runbook.md). Edit the file and restart the watchdog to update it.
- `cost-ledger.md`. Read it with `npm run ledger:show`, because Telegram and Switch Console can't open room documents.

Check that it answers: send `@burn-watchdog status` in the group. Type the name in full: Telegram doesn't autocomplete agent names.

## 4. @claude-code (Switch Console agent)

Switch Console → **Your Agents** → the dashed **+** card:

| Field                             | Value                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Name                              | `claude-code` (it must be exactly this: the watchdog addresses it by name)                     |
| Description                       | `Investigates and fixes order-worker cost incidents; runs live commands only after approval`   |
| Agent instructions                | all of [`room/agents/claude-code.md`](../room/agents/claude-code.md)                           |
| Run location                      | **This computer**                                                                              |
| Directory                         | the repo's `scenario` folder, e.g. `/Users/<you>/BurnSwitch/scenario` (can't be changed later) |
| Agent provider                    | **Claude Code**                                                                                |
| Settings → **Auto mode**          | **Off** (it starts on: turn it off)                                                            |
| Settings → **Bypass permissions** | **Off**                                                                                        |
| Who can talk to your agent        | **Me and my agents (default)**. This lets you and @burn-watchdog address it.                   |

Then click **Add agent**.

Why Auto mode must be off: with it on, Claude Code decides for itself which commands run without asking. With it off, every command it wants to run becomes a request in the room (**Allow once / Allow for this session / Decline**), and that request is the approval gate. For live changes, always choose **Allow once**.

Add it to the room: on the agent's page, use **Add to room → finops-control**, or send `!invite-agent @claude-code` in the group. Check with `!list-agents`.

Check that it answers: send `@claude-code hi, what's in your working directory?`

## 5. @finops-auditor (joins late)

Create it like @claude-code, with these differences:

| Field                          | Value                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Name                           | `finops-auditor`                                                                     |
| Description                    | `Writes the post-mortem for a resolved cost incident from the ledger and the thread` |
| Agent instructions             | all of [`room/agents/finops-auditor.md`](../room/agents/finops-auditor.md)           |
| Directory                      | the repo's `room` folder (it doesn't need code)                                      |
| Auto mode / Bypass permissions | **Off** / **Off**                                                                    |

**Don't add it to the room yet.** It joins after the incident is resolved (step 6).

## 6. Run the incident

```bash
npm run scenario:reset -- --fresh   # clean LocalStack + buggy worker (restores the scenario-start tag)
npm run watchdog:dev                # if it isn't running already
npm run burn:start                  # normal traffic, then checkout-v2's malformed orders after 15 s
```

What should happen:

1. About 1 minute later, @burn-watchdog posts one 🔥 alert addressed to @claude-code.
2. @claude-code investigates, reproduces with `bin/repro`, and proposes containment.
3. You reply e.g. `@claude-code go ahead with containment`. For each command, a request appears: tap **Allow once**. After each one, @claude-code posts `Approved by jeevesh2605: …`, and the ledger records it.
4. @burn-watchdog posts 🧯 contained.
5. @claude-code patches and tests, then proposes recovery. Approve deploy, ReportBatchItemFailures and the concurrency restore, one at a time.
6. @burn-watchdog posts ✅ resolved.
7. `npm run burn:stop`, then `!invite-agent @finops-auditor` and `@finops-auditor please write the post-mortem for INC-…` (use the incident id from the alert).

Afterwards: `npm run ledger:show` prints the full ledger.

## Troubleshooting

| Symptom                                                     | Fix                                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An agent ignores your message ("run 3a" gets no reply)      | Start every message to an agent with its name, e.g. `@claude-code run 3a`. Messages without it don't reach the agent. Commands start with `!` (`!invite-agent`, not `Invite-agent`). |
| Alert says "couldn't address @claude-code directly"         | @claude-code isn't in the room or isn't named `claude-code`. Check with `!list-agents`.                                                                                              |
| @claude-code never asks for approval and just runs commands | Auto mode or Bypass permissions is on. Turn both off on its page (**General**), then send `!reset @claude-code`.                                                                     |
| Nobody answers in Telegram                                  | The Telegram bridge stopped (often after a network timeout). Use **Connectors → Telegram → ⋮ → Disconnect app…** and connect again.                                                  |
| Watchdog can't reach Switch                                 | Switch Console may have moved ports after a restart. The watchdog re-reads them; restart it.                                                                                         |
| `docker compose` says Docker Desktop is paused              | Resume it from the whale menu.                                                                                                                                                       |
