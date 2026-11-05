// HTTP side of the Switch agent protocol: operations and plain messages.
// Every call carries the agent's own API key; the registration key is used only in register.ts.

export class SwitchHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    what: string,
  ) {
    super(`${what} failed: HTTP ${status} ${detail}`);
  }
}

/** Network trouble or a connection that isn't open yet: retrying later can succeed. */
export function isTransient(err: unknown): boolean {
  if (err instanceof SwitchHttpError) {
    return err.status >= 500 || (err.status === 409 && /not open/.test(err.detail));
  }
  return err instanceof TypeError || (err as Error)?.name === "TimeoutError"; // fetch failed
}

const WRITES = new Set([
  "post_message",
  "send_targeted_message",
  "create_room_document",
  "update_room_document",
  "delete_room_document",
]);

function dryResult(name: string, args: Record<string, unknown>) {
  const body = String(args.body ?? args.content ?? args.name ?? "").replace(/\n/g, " ⏎ ");
  console.log(`[dry-run] ${name}: ${body.slice(0, 160)}`);
  return {
    event_id: `dry-${Date.now()}`,
    target_statuses: {},
    document_id: String(args.document_id ?? "dry-doc"),
    status: "ok",
  };
}

export class SwitchHttp {
  /** Set once the WebSocket is open; binds operations to the room the connection claimed. */
  connectionId?: string;

  /** Calls that would post or change something in the room are only logged (tests). */
  dryRun = false;

  constructor(
    public baseUrl: string,
    readonly agentId: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, what = path): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.connectionId) headers["X-Switch-Connection-Id"] = this.connectionId;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new SwitchHttpError(res.status, text, what);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** GET /agents/{id}/ops: the live operation registry. */
  async listOps(): Promise<Record<string, { description: string; input_schema: unknown }>> {
    const res = await this.request<{
      operations: Record<string, { description: string; input_schema: unknown }>;
    }>("GET", `/agents/${this.agentId}/ops`);
    return res.operations;
  }

  /** POST /agents/{id}/ops/{name} with the arguments unwrapped in the body. */
  async op<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.dryRun && WRITES.has(name)) return dryResult(name, args) as T;
    const res = await this.request<{ result: T }>(
      "POST",
      `/agents/${this.agentId}/ops/${name}`,
      args,
      `operation ${name}`,
    );
    return res.result;
  }

  /** POST /agents/{id}/message: posts to a room without needing a connection. No addressing. */
  async postMessage(roomId: string, content: string): Promise<{ event_id: string }> {
    if (this.dryRun) return dryResult("post message", { room_id: roomId, body: content }) as never;
    return this.request(
      "POST",
      `/agents/${this.agentId}/message`,
      { room_id: roomId, content },
      "post message",
    );
  }
}
