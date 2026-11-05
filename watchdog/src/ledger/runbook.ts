// Publishes room/finops-runbook.md as a room document, so @claude-code and the auditor can
// load it. (Attaching a library document needs the Gateway web page, which the local
// Switch server doesn't have; a room document only needs the watchdog's connection.)
// Called once per connect: it creates the document, or updates it only if the file changed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DetectorState } from "../incident/detector.js";
import { log } from "../log.js";
import type { SwitchHttp } from "../switch/http.js";

export const RUNBOOK_NAME = "finops-runbook.md";
const FILE = new URL("../../../room/finops-runbook.md", import.meta.url);

type Doc = { id: string; name: string; created_by_agent_id?: string | null };

export async function publishRunbook(
  http: SwitchHttp,
  agentId: string,
  state: DetectorState,
): Promise<void> {
  try {
    const content = readFileSync(FILE, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    const { documents = [] } = await http.op<{ documents?: Doc[] }>("list_references");
    const existing = documents.find(
      (d) => d.name === RUNBOOK_NAME && d.created_by_agent_id === agentId,
    );
    if (existing && state.runbook?.documentId === existing.id && state.runbook.hash === hash) {
      return; // already up to date
    }
    let documentId: string;
    if (existing) {
      await http.op("update_room_document", { document_id: existing.id, content });
      documentId = existing.id;
      log("info", `updated room document ${RUNBOOK_NAME}`);
    } else {
      ({ document_id: documentId } = await http.op<{ document_id: string }>(
        "create_room_document",
        {
          name: RUNBOOK_NAME,
          description: "How to contain and fix an order-worker retry storm, step by step",
          instructions:
            "Follow it for any cost incident on order-worker. Steps marked LIVE need the " +
            "on-call human's approval in this room before they run.",
          content,
        },
      ));
      log("info", `created room document ${RUNBOOK_NAME} (${documentId})`);
    }
    state.runbook = { documentId, hash };
  } catch (err) {
    log("warn", `couldn't publish ${RUNBOOK_NAME}: ${(err as Error).message}`);
  }
}
