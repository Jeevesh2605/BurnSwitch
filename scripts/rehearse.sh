#!/usr/bin/env bash
# npm run rehearse [-- --real-aws]
# One command for a full demo run. It prepares everything, then tells you what to do in
# Telegram at each act and waits for the watchdog to see it happen:
#   Act 1  burn alert             (automatic, ~1 min after the burn starts)
#   Act 2  handoff + diagnosis    (@claude-code investigates and proposes; you read)
#   Act 3  containment            (you approve 3a from your phone)
#   Act 4  fix + recovery         (you approve 4b, 4c, 4d, then 4e once the backlog drained)
#   Act 5  resolved + ledger      (automatic: final message count, then the ledger)
#   Act 6  late auditor           (you invite @finops-auditor and ask for the post-mortem)
# Ctrl-C stops the rehearsal and the traffic; the watchdog keeps running.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG="$ROOT/.state/watchdog.log"
REAL=()
for arg in "$@"; do [[ "$arg" == "--real-aws" ]] && REAL=(--real-aws); done
ACT_TIMEOUT_S="${ACT_TIMEOUT_S:-900}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say() { printf '  %s\n' "$*"; }
elapsed() { echo "$(($(date +%s) - T0))s"; }

# Waits until the watchdog log has a line matching $1 (written after this run started).
wait_for() {
  local pattern="$1" deadline=$(($(date +%s) + ACT_TIMEOUT_S))
  until tail -n +"$LOG_START" "$LOG" 2>/dev/null | grep -qE "$pattern"; do
    if (($(date +%s) > deadline)); then
      say "⏱  Nothing after $((ACT_TIMEOUT_S / 60)) min. Check the group, then: tail -f .state/watchdog.log"
      exit 1
    fi
    if ! pgrep -f "watchdog/src/index.ts" >/dev/null; then
      say "❌ The watchdog stopped. Last lines:"; tail -5 "$LOG"; exit 1
    fi
    sleep 3
  done
}

cleanup() {
  echo
  npm run -s burn:stop -- ${REAL[@]+"${REAL[@]}"} >/dev/null 2>&1 || true
  say "Traffic stopped. The watchdog keeps running (log: .state/watchdog.log)."
}
trap cleanup INT

bold "BurnSwitch rehearsal${REAL:+ (REAL AWS)}"
npm run -s preflight -- ${REAL[@]+"${REAL[@]}"} || exit 1

bold "Before we start, in the Telegram group"
say "• If @finops-auditor is in the room: !remove-agent @finops-auditor (it joins late, in act 6)"
say "• If @claude-code has an old session: !reset @claude-code"
read -r -p "  Press Enter when ready... " _

bold "Setting up a clean run"
npm run -s burn:stop -- ${REAL[@]+"${REAL[@]}"} >/dev/null 2>&1 || true
pkill -f "watchdog/src/index.ts" 2>/dev/null && sleep 1 || true
# An incident still open from an earlier run is closed as "abandoned" (it stays in the
# ledger; nothing is dropped), so the new run starts with exactly one incident.
npx tsx watchdog/src/incident/abandon.ts "a new rehearsal started before it resolved" | sed 's/^/  /'
if ((${#REAL[@]})); then
  npm run -s scenario:reset -- --real-aws
else
  npm run -s scenario:reset -- --fresh
fi

LOG_START=$(($(wc -l <"$LOG" 2>/dev/null || echo 0) + 1))
nohup npx tsx watchdog/src/index.ts ${REAL[@]+"${REAL[@]}"} >>"$LOG" 2>&1 &
wait_for "INFO connected"
say "✅ watchdog connected"

T0=$(date +%s)
npm run -s burn:start -- ${REAL[@]+"${REAL[@]}"} | sed 's/^/  /'

bold "Act 1: the burn (wait ~1 min)"
say "Normal orders for 15 s, then checkout-v2's malformed orders start a retry storm."
wait_for "INCIDENT .* opened"
INC="$(tail -n +"$LOG_START" "$LOG" | grep -oE 'INCIDENT INC-[0-9-]+-[0-9a-f]+ opened' | tail -1 | awk '{print $2}')"
say "🔥 $INC alerted after $(elapsed). It's in the group, addressed to @claude-code."

bold "Act 2: handoff (watch the group, ~1–3 min)"
say "@claude-code acknowledges, reproduces with bin/repro, names the cause and the commit,"
say "then proposes containment (3a) and writes the patch."

bold "Act 3: containment (your phone)"
say "Send this, and tap Allow once on the request (never 'Allow for this session'):"
say "    @claude-code run 3a"
wait_for "INCIDENT $INC contained"
say "🧯 contained at $(elapsed)."

bold "Act 4: fix and recovery (your phone)"
say "When the patch and tests are posted, send one at a time, Allow once on each:"
say "    @claude-code run 4b      (deploy the patch)"
say "    @claude-code run 4c      (partial batch failures)"
say "    @claude-code run 4d      (resume processing; then it runs bin/queue-check)"
say "    @claude-code run 4e      (redrive policy, once queue-check says the good orders drained)"
say "  Redrive goes last on purpose: attached earlier, it dead-letters the stuck good orders."
wait_for "INCIDENT $INC resolved"
say "✅ resolved at $(elapsed)."

bold "Act 5: after burn, final count, ledger"
say "If 4e isn't done yet: @claude-code run 4e (once queue-check says drained), Allow once."
say "Waiting for the after burn: backlog drained under normal traffic for a minute ..."
wait_for "after burn for $INC"
tail -n +"$LOG_START" "$LOG" | grep "after burn for $INC" | tail -1 | sed 's/.*after burn for /  📉 /'
npm run -s burn:stop -- ${REAL[@]+"${REAL[@]}"} | sed 's/^/  /'
say "Waiting for the final message count (traffic stopped, queue empty) ..."
wait_for "final count for $INC"
tail -n +"$LOG_START" "$LOG" | grep "final count for $INC" | tail -1 | sed 's/.*final count for /  📊 /'
sleep 2
npm run -s ledger:show | sed -n "/## $INC/,/### Approvals/p" | sed 's/^/  /'

bold "Act 6: the late auditor (your phone)"
say "    !invite-agent @finops-auditor"
say "    @finops-auditor please write the post-mortem for $INC"
say ""
say "Done. Full ledger: npm run ledger:show"
