#!/usr/bin/env bash
# npm run demo:reset [-- --room "<room name>"]
# Gets everything ready for a clean, single-incident recording:
#   1. stops the traffic generator and the watchdog
#   2. archives the watchdog's state (incidents, change log, traffic counts) to .state/archive/
#   3. in Switch: deletes cost-ledger.md; with --room, switches to that room (adds the agents,
#      sets the room instructions)
#   4. recreates LocalStack and restores the buggy worker from the scenario-start tag
# Then: npm run rehearse.
set -euo pipefail
cd "$(dirname "$0")/.."
say() { printf '  %s\n' "$*"; }

echo "Demo reset"
npm run -s burn:stop >/dev/null 2>&1 || true
pkill -f "watchdog/src/index.ts" 2>/dev/null && say "watchdog stopped" || true

ARCHIVE=".state/archive/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ARCHIVE"
for f in watchdog-state.json change-log.jsonl traffic-stats.json; do
  [[ -f ".state/$f" ]] && mv ".state/$f" "$ARCHIVE/" && say "archived .state/$f"
done

npx tsx scripts/demo-reset-switch.ts "$@"

if ! git diff --quiet -- scenario/order-worker 2>/dev/null; then
  say "scenario/order-worker has local edits (a fix from an earlier run): they're replaced by the tag"
fi
npm run -s scenario:reset -- --fresh | tail -1 | sed 's/^/  /'
rm -f .state/change-log.jsonl # setup changes from this reset aren't part of the demo

cat <<'MSG'

Ready. In the Telegram group:
  !reset @claude-code                 (no memory of earlier incidents)
  !remove-agent @finops-auditor       (only if it's in the room: it joins late)
Then: npm run rehearse
MSG
