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

export class SwitchHttp {
  /** Set once the WebSocket is open; binds operations to the room the connection claimed. */
  connectionId?: string;

  constructor(
    readonly baseUrl: string,
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
    return this.request(
      "POST",
      `/agents/${this.agentId}/message`,
      { room_id: roomId, content },
      "post message",
    );
  }
}
