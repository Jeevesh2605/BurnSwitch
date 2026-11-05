// WebSocket side of the Switch agent protocol (SSE is deprecated).
// Docs: https://docs.switchagents.ai/switch-rooms/internals/agent-connection.md
//
// - One connection id, kept across reconnects and restarts (.state/switch-connection.json).
// - Pings are answered first, with the highest sequence processed.
// - Reconnects with backoff, resuming from the cursor. Stops for good on `taken_over`,
//   `closed`, and refusals that retrying can't fix.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { log } from "../log.js";
import { wsUrl } from "./config.js";

const STATE_DIR = new URL("../../../.state/", import.meta.url);
const STATE_FILE = new URL("switch-connection.json", STATE_DIR);
const CLIENT_VERSION = "0.1.0";

export interface MessagePayload {
  addressed: boolean;
  sender: string;
  sender_name: string;
  message_id: string;
  body: string;
  timestamp: number;
  thread_id: string | null;
  attachments: unknown[];
}

export interface DomainEvent<P = Record<string, unknown>> {
  type: "message" | "command" | "room_join";
  room_id: string;
  bridge_id: string | null;
  channel_type: string | null;
  payload: P;
  sequence: number;
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
  id?: number;
}

interface SavedState {
  connectionId: string;
  cursor?: number;
}

export interface ConnectionEvents {
  ready: [state: Record<string, unknown>];
  /** A message that addresses this agent (payload.addressed === true). */
  addressed: [event: DomainEvent<MessagePayload>];
  /** Every domain event, addressed or not, for logging and context. */
  event: [event: DomainEvent];
  stopped: [reason: string];
}

const FATAL_EVICTIONS = new Set(["taken_over", "closed"]);
const FATAL_CLOSE_CODES = new Set([4400, 4401, 4403, 4409]);

export class SwitchConnection extends EventEmitter<ConnectionEvents> {
  readonly connectionId: string;
  private cursor?: number;
  private generation?: number;
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private stableTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly baseUrl: string,
    private readonly agentId: string,
    private readonly apiKey: string,
    private readonly roomId: string,
  ) {
    super();
    const saved = this.load();
    this.connectionId = saved?.connectionId ?? randomUUID();
    this.cursor = saved?.cursor;
    this.save();
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(reason = "stopped"): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stableTimer);
    this.ws?.close(1000);
    this.emit("stopped", reason);
  }

  private open(): void {
    const params = new URLSearchParams({
      connection_id: this.connectionId,
      rooms: this.roomId,
      start_from: this.cursor !== undefined ? String(this.cursor) : "head",
      client: "burn-watchdog",
      client_version: CLIENT_VERSION,
    });
    // Fence reconnects within this process so we only ever take back our own connection.
    // (On a fresh start there's no generation yet; reopening our own id is a self-takeover.)
    if (this.generation !== undefined) params.set("expected_generation", String(this.generation));

    const url = `${wsUrl(this.baseUrl)}/agents/${this.agentId}/connection/ws?${params}`;
    log("info", `connecting (attempt ${this.attempt + 1}, start_from=${params.get("start_from")})`);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    this.ws = ws;
    let evictedCode: string | undefined;

    ws.on("message", (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString()) as Frame;
      } catch {
        log("warn", "ignoring a frame that isn't JSON");
        return;
      }

      // Answer pings before anything else.
      if (frame.event === "ping") {
        ws.send(JSON.stringify({ type: "pong", cursor: this.cursor ?? 0 }));
        return;
      }

      switch (frame.event) {
        case "connection_state":
          this.generation = Number(frame.data.generation);
          if (typeof frame.data.cursor === "number") this.cursor = frame.data.cursor;
          this.save();
          log("info", "connected", {
            rooms: frame.data.rooms,
            cursor: frame.data.cursor,
            generation: frame.data.generation,
            protocol: frame.data.protocol,
          });
          // Only reset the backoff once the connection has stayed up for a while.
          this.stableTimer = setTimeout(() => (this.attempt = 0), 30_000);
          this.emit("ready", frame.data);
          return;
        case "gap":
          log("warn", "gap: some events could not be replayed", frame.data);
          if (typeof frame.data.resumed_at === "number") this.cursor = frame.data.resumed_at;
          this.save();
          return;
        case "evicted":
          evictedCode = String(frame.data.code);
          log("warn", `evicted: ${evictedCode}`, frame.data);
          return;
        case "refused":
          log("error", "connection refused", frame.data);
          return;
        case "subscription_changed":
        case "room_released":
          log("info", frame.event, frame.data);
          return;
      }

      if (typeof frame.id === "number") {
        const ev = frame.data as unknown as DomainEvent;
        this.emit("event", ev);
        if (ev.type === "message" && (ev.payload as unknown as MessagePayload).addressed) {
          this.emit("addressed", ev as unknown as DomainEvent<MessagePayload>);
        }
        this.cursor = Math.max(this.cursor ?? 0, frame.id);
        this.save();
      }
    });

    ws.on("error", (err) => log("warn", `socket error: ${err.message}`));

    ws.on("close", (code, reasonBuf) => {
      clearTimeout(this.stableTimer);
      const reason = reasonBuf.toString();
      if (this.stopped) return;

      if (evictedCode && FATAL_EVICTIONS.has(evictedCode)) {
        log("error", `not reconnecting after eviction "${evictedCode}"`);
        this.stop(`evicted: ${evictedCode}`);
        return;
      }
      if (FATAL_CLOSE_CODES.has(code)) {
        log("error", `not reconnecting: closed with ${code} ${reason}`);
        this.stop(`closed ${code}`);
        return;
      }

      const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.5 + Math.random() / 2);
      this.attempt += 1;
      log(
        "warn",
        `disconnected (${code}${reason ? ` ${reason}` : ""}); retrying in ${Math.round(delay / 1000)}s`,
      );
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    });
  }

  private load(): SavedState | undefined {
    if (!existsSync(STATE_FILE)) return undefined;
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SavedState;
    } catch {
      return undefined;
    }
  }

  private save(): void {
    mkdirSync(STATE_DIR, { recursive: true });
    const state: SavedState = { connectionId: this.connectionId, cursor: this.cursor };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}
