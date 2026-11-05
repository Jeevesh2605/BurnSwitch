// npx tsx watchdog/src/incident/abandon.ts "<reason>"
// Closes an open incident as "abandoned" (scenario reset before it resolved). It stays in the
// state and the ledger: an incident is never silently dropped. Run while the watchdog is stopped.
import { loadState, saveState, hasState } from "./store.js";

const reason = process.argv[2] ?? "scenario reset";
if (!hasState()) process.exit(0);
const st = loadState();
const inc = st.incident;
if (!inc) process.exit(0);
inc.status = "abandoned";
inc.abandonedAt = new Date().toISOString();
inc.abandonedReason = reason;
inc.timeline.push({ at: inc.abandonedAt, kind: "event", text: `Abandoned: ${reason}` });
st.closed.push(inc);
st.incident = undefined;
st.outbox = [];
st.healthy = [];
st.breachStreak = 0;
st.containStreak = 0;
st.recoverStreak = 0;
saveState(st);
console.log(`Closed ${inc.id} as abandoned (${reason}); it stays in the ledger.`);
