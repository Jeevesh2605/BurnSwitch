// cost-ledger.md: a room document in #finops-control that @burn-watchdog owns.
//   - created on first connect, or found again by name after a restart
//   - rewritten only when an incident changes (every update also posts a short notice in
//     the room, so it is not refreshed on a timer)
// Ops (switch-core 0.31.0): create_room_document {name, description, instructions, content},
// update_room_document {document_id, content}, list_references -> documents[{id, name,
// created_by_agent_id}]. All need the connection bound to the room (X-Switch-Connection-Id).
import type { DeployManifest, Thresholds } from "../config.js";
import { usd } from "../cost/model.js";
import type { DetectorState, Incident } from "../incident/detector.js";
import { log } from "../log.js";
import { SwitchHttpError, type SwitchHttp } from "../switch/http.js";

export const LEDGER_NAME = "cost-ledger.md";
type Doc = { id: string; name: string; created_by_agent_id?: string | null };
const MAX_CLOSED = 5;

const time = (iso: string) => iso.slice(11, 19);
const dateTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
const span = (from: string, to?: string) => {
  if (!to) return "—";
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const money = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const x = (a: number, b: number) => (b > 0 ? ` (${(a / b).toFixed(1)}× baseline)` : "");
const STATUS = { burning: "🔥 burning", contained: "🧯 contained", resolved: "✅ resolved" };

function renderIncident(inc: Incident, deploy: DeployManifest, t: Thresholds): string {
  const d = deploy.deploy;
  const after = inc.finalUsdPerHr != null ? `${usd(inc.finalUsdPerHr)}/hr` : "— (not resolved yet)";
  const rows: [string, string][] = [
    ["Status", STATUS[inc.status]],
    ["Trigger", `commit \`${d.commit}\` "${d.message}" (deployed ${dateTime(d.deployed_at)} UTC)`],
    ["Opened", `${dateTime(inc.openedAt)} UTC`],
    ["Time to contain", span(inc.openedAt, inc.containedAt)],
    ["Time to resolve", span(inc.openedAt, inc.resolvedAt)],
    ["Burn before (baseline)", `${usd(inc.baselineUsdPerHr)}/hr`],
    ["Burn at peak", `${usd(inc.peakUsdPerHr)}/hr${x(inc.peakUsdPerHr, inc.baselineUsdPerHr)}`],
    ["Burn after", after],
    [
      "Spend while open (est.)",
      `${money(inc.spendUsd ?? 0)}, of which ${money(inc.excessUsd ?? 0)} above baseline`,
    ],
    ["Peak invocations", `${inc.peakInvocationsPerMin.toFixed(0)}/min`],
    ["Peak error rate", `${(inc.peakErrorRate * 100).toFixed(0)}%`],
    ["Peak receive count", String(inc.peakReceiveCount ?? "?")],
  ];
  if (inc.dlqAtResolve != null) rows.push([`Messages kept in ${t.dlq}`, String(inc.dlqAtResolve)]);

  const timeline = (inc.timeline ?? []).map((e) => `- ${time(e.at)} ${e.text}`);
  const actions = (inc.timeline ?? []).filter((e) => e.kind === "action");
  const approvals = inc.approvals ?? [];

  return [
    `## ${inc.id}`,
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|")} |`),
    "",
    "### Timeline (UTC)",
    "",
    ...(timeline.length ? timeline : ["- (nothing yet)"]),
    "",
    "### Actions taken",
    "",
    "Infra changes the watchdog saw on order-worker, its queue and its event source mapping.",
    "",
    ...(actions.length
      ? actions.map((e) => `- ${time(e.at)} ${e.text}`)
      : ["- None yet. No live change has been made."]),
    "",
    "### Approvals",
    "",
    ...(approvals.length
      ? [
          "| Time (UTC) | Approved by | Action | Reported by |",
          "|---|---|---|---|",
          ...approvals.map(
            (a) =>
              `| ${time(a.at)} | ${a.by} | ${a.action.replace(/\|/g, "\\|")} | @${a.reportedBy} |`,
          ),
        ]
      : ["- None recorded yet."]),
    "",
    "> TODO(approvals): Switch stores who tapped Allow on an approval card (`answered_by`), " +
      "but no agent operation returns it (`read_context` has only messages and joins). " +
      'Rows above come from the "Approved by <name>: <action>" line that the agent which ran ' +
      "the change posts in the room. Check them against the approval cards in the chat.",
  ].join("\n");
}

export function renderLedger(
  state: DetectorState,
  deploy: DeployManifest,
  t: Thresholds,
  updatedAt: string,
): string {
  const closed = [...state.closed].reverse().slice(0, MAX_CLOSED);
  const parts = [
    `# Cost ledger: ${t.function}`,
    "",
    `Kept by @burn-watchdog. Rewritten on every incident event (opened, action, approval, ` +
      `contained, resolved). Last update ${dateTime(updatedAt)} UTC.`,
    "",
    "Costs are estimates from Lambda request and GB-second rates in `config/pricing.json`.",
  ];
  if (state.incident)
    parts.push("", "# Open incident", "", renderIncident(state.incident, deploy, t));
  else parts.push("", "No open incident.");
  if (closed.length) {
    parts.push("", `# Closed incidents (latest ${MAX_CLOSED})`);
    for (const inc of closed) parts.push("", renderIncident(inc, deploy, t));
  }
  parts.push("", stateMarker(state));
  return parts.join("\n") + "\n";
}

// ---- State carried in the ledger ----------------------------------------------------------
// The ledger ends with a hidden comment holding the incident state, so a watchdog that lost
// .state/ (new machine, deleted folder) resumes the open incident instead of alerting again.

const MARKER = /<!-- burn-watchdog-state v1 ([A-Za-z0-9+/=]+) -->/;

function stateMarker(state: DetectorState): string {
  const carried = { incident: state.incident, closed: state.closed.slice(-MAX_CLOSED) };
  const b64 = Buffer.from(JSON.stringify(carried)).toString("base64");
  return `<!-- burn-watchdog-state v1 ${b64} -->`;
}

export function parseStateMarker(
  content: string,
): Pick<DetectorState, "incident" | "closed"> | undefined {
  const m = MARKER.exec(content);
  if (!m) return undefined;
  try {
    return JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as Pick<
      DetectorState,
      "incident" | "closed"
    >;
  } catch {
    return undefined;
  }
}

/** Reads the incident state back from the ledger in the room, if there is one. */
export async function restoreFromLedger(
  http: SwitchHttp,
  agentId: string,
): Promise<{ documentId: string; state: Pick<DetectorState, "incident" | "closed"> } | undefined> {
  const res = await http.op<{ documents?: Doc[] }>("list_references");
  const doc = res.documents?.find(
    (d) => d.name === LEDGER_NAME && d.created_by_agent_id === agentId,
  );
  if (!doc) return undefined;
  const [loaded] = await http.op<{ content: string }[]>("load_internal_documents", {
    ids: [doc.id],
  });
  const state = loaded ? parseStateMarker(loaded.content) : undefined;
  return state ? { documentId: doc.id, state } : undefined;
}

/** What the ledger shows, minus the volatile bits: the document is rewritten when this changes. */
export function ledgerKey(state: DetectorState): string {
  const k = (i: Incident) => [i.id, i.status, i.timeline?.length ?? 0, i.approvals?.length ?? 0];
  return JSON.stringify([state.incident ? k(state.incident) : null, state.closed.map(k)]);
}

export class Ledger {
  constructor(
    private readonly http: SwitchHttp,
    private readonly agentId: string,
    private readonly state: DetectorState,
  ) {}

  private async find(): Promise<string | undefined> {
    const res = await this.http.op<{ documents?: Doc[] }>("list_references");
    return res.documents?.find(
      (d) => d.name === LEDGER_NAME && d.created_by_agent_id === this.agentId,
    )?.id;
  }

  private async create(content: string): Promise<string> {
    const res = await this.http.op<{ document_id: string }>("create_room_document", {
      name: LEDGER_NAME,
      description: "Cost incidents for order-worker: burn, timeline, actions, approvals",
      instructions:
        "Kept by @burn-watchdog; don't edit. Use it for incident ids, burn before/after, " +
        "time to contain and the approval trail when reporting or writing a postmortem.",
      content,
    });
    return res.document_id;
  }

  /** Writes the ledger if it changed (or `force`). Errors are logged, never thrown. */
  async sync(content: string, force = false): Promise<void> {
    const key = ledgerKey(this.state);
    const l = (this.state.ledger ??= {});
    if (!force && l.documentId && l.syncedKey === key) return;
    try {
      l.documentId ??= await this.find();
      if (!l.documentId) {
        l.documentId = await this.create(content);
        log("info", `created room document ${LEDGER_NAME} (${l.documentId})`);
      } else {
        try {
          await this.http.op("update_room_document", { document_id: l.documentId, content });
        } catch (err) {
          // Deleted from the room UI: create it again.
          if (!(err instanceof SwitchHttpError && [400, 404, 422].includes(err.status))) throw err;
          log("warn", `ledger document gone (${err.message}); creating it again`);
          const found = await this.find();
          if (found) {
            l.documentId = found;
            await this.http.op("update_room_document", { document_id: found, content });
          } else {
            l.documentId = await this.create(content);
          }
        }
        log("info", `updated ${LEDGER_NAME}`);
      }
      l.syncedKey = key;
    } catch (err) {
      log("warn", `ledger sync failed, will retry on the next sample: ${(err as Error).message}`);
    }
  }
}
