type DurableObjectStorageLike = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
};

type DurableObjectStateLike = {
  storage: DurableObjectStorageLike;
};

type DurableObjectIdLike = unknown;

export type AuthorizationCodeCoordinatorNamespaceLike = {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
};

type IssuePayload<TRecord> = {
  code: string;
  record: TRecord;
};

type ConsumePayload = {
  code: string;
};

type RefreshBeginPayload = {
  token: string;
  pendingTtlMs?: number;
};

type RefreshCompletePayload = {
  token: string;
  replayTtlMs?: number;
  response: RefreshReplayResponse;
};

type RefreshReplayResponse = {
  client_id: string;
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
};

type StoredCodeRecord<TRecord> = {
  record: TRecord;
  expiresAt: number;
};

type StoredRefreshRecord =
  | { kind: "pending"; expiresAt: number }
  | { kind: "replay"; expiresAt: number; response: RefreshReplayResponse };

type RefreshBeginResult =
  | { state: "leader" }
  | { state: "wait" }
  | { state: "replay"; response: RefreshReplayResponse };

function jsonResponse(status: number, body?: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function parseJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export class AuthorizationCodeCoordinator {
  constructor(private readonly state: DurableObjectStateLike) {}

  private refreshKey(token: string): string {
    return "refresh:" + token;
  }

  private async readRefreshRecord(token: string): Promise<StoredRefreshRecord | null> {
    const record = await this.state.storage.get<StoredRefreshRecord>(this.refreshKey(token));
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      await this.state.storage.delete(this.refreshKey(token));
      return null;
    }
    return record;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/issue") {
      const payload = await parseJson<IssuePayload<unknown>>(req);
      if (!payload || typeof payload.code !== "string" || !payload.record || typeof payload.record !== "object") {
        return jsonResponse(400, { error: "INVALID_ISSUE_REQUEST" });
      }
      const record = payload.record as Record<string, unknown>;
      const expiresAt = typeof record["expires_at"] === "number" ? record["expires_at"] : 0;
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
        return jsonResponse(400, { error: "INVALID_ISSUE_EXPIRY" });
      }
      await this.state.storage.put(payload.code, {
        record: payload.record,
        expiresAt
      } satisfies StoredCodeRecord<unknown>);
      return new Response(null, { status: 204 });
    }

    if (req.method === "POST" && url.pathname === "/consume") {
      const payload = await parseJson<ConsumePayload>(req);
      if (!payload || typeof payload.code !== "string" || !payload.code) {
        return jsonResponse(400, { error: "INVALID_CONSUME_REQUEST" });
      }
      const stored = await this.state.storage.get<StoredCodeRecord<unknown>>(payload.code);
      if (!stored) {
        return jsonResponse(200, { record: null });
      }
      await this.state.storage.delete(payload.code);
      if (!stored.expiresAt || stored.expiresAt < Date.now()) {
        return jsonResponse(200, { record: null });
      }
      return jsonResponse(200, { record: stored.record as Record<string, unknown> });
    }

    if (req.method === "POST" && url.pathname === "/refresh/begin") {
      const payload = await parseJson<RefreshBeginPayload>(req);
      if (!payload || typeof payload.token !== "string" || !payload.token) {
        return jsonResponse(400, { error: "INVALID_REFRESH_BEGIN_REQUEST" });
      }
      const existing = await this.readRefreshRecord(payload.token);
      if (existing?.kind === "replay") {
        return jsonResponse(200, { state: "replay", response: existing.response });
      }
      if (existing?.kind === "pending") {
        return jsonResponse(200, { state: "wait" });
      }
      const pendingTtlMs = typeof payload.pendingTtlMs === "number" && Number.isFinite(payload.pendingTtlMs)
        ? Math.max(payload.pendingTtlMs, 1_000)
        : 15_000;
      await this.state.storage.put(this.refreshKey(payload.token), {
        kind: "pending",
        expiresAt: Date.now() + pendingTtlMs
      } satisfies StoredRefreshRecord);
      return jsonResponse(200, { state: "leader" });
    }

    if (req.method === "POST" && url.pathname === "/refresh/complete") {
      const payload = await parseJson<RefreshCompletePayload>(req);
      if (
        !payload ||
        typeof payload.token !== "string" ||
        !payload.token ||
        !payload.response ||
        typeof payload.response !== "object" ||
        typeof payload.response.client_id !== "string" ||
        typeof payload.response.access_token !== "string" ||
        typeof payload.response.token_type !== "string" ||
        typeof payload.response.expires_in !== "number" ||
        typeof payload.response.scope !== "string"
      ) {
        return jsonResponse(400, { error: "INVALID_REFRESH_COMPLETE_REQUEST" });
      }
      const replayTtlMs = typeof payload.replayTtlMs === "number" && Number.isFinite(payload.replayTtlMs)
        ? Math.max(payload.replayTtlMs, 1_000)
        : 120_000;
      await this.state.storage.put(this.refreshKey(payload.token), {
        kind: "replay",
        expiresAt: Date.now() + replayTtlMs,
        response: payload.response
      } satisfies StoredRefreshRecord);
      return new Response(null, { status: 204 });
    }

    if (req.method === "POST" && (url.pathname === "/refresh/fail" || url.pathname === "/refresh/clear")) {
      const payload = await parseJson<RefreshBeginPayload>(req);
      if (!payload || typeof payload.token !== "string" || !payload.token) {
        return jsonResponse(400, { error: "INVALID_REFRESH_CLEAR_REQUEST" });
      }
      await this.state.storage.delete(this.refreshKey(payload.token));
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { error: "NOT_FOUND" });
  }
}

export class AuthorizationCodeCoordinatorClient<TRecord> {
  constructor(private readonly namespace: AuthorizationCodeCoordinatorNamespaceLike) {}

  private stubFor(code: string) {
    const id = this.namespace.idFromName("oauth-code:" + code.slice(0, 2));
    return this.namespace.get(id);
  }

  async issue(code: string, record: TRecord): Promise<void> {
    const response = await this.stubFor(code).fetch("https://auth-coordinator/issue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, record })
    });
    if (response.status !== 204) {
      throw new Error("Authorization code coordinator failed to issue code.");
    }
  }

  async consume(code: string): Promise<TRecord | null> {
    const response = await this.stubFor(code).fetch("https://auth-coordinator/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    if (!response.ok) {
      throw new Error("Authorization code coordinator failed to consume code.");
    }
    const payload = (await response.json()) as { record?: TRecord | null };
    return payload.record ?? null;
  }
}

export class RefreshReplayCoordinatorClient {
  constructor(private readonly namespace: AuthorizationCodeCoordinatorNamespaceLike) {}

  private stubFor(token: string) {
    const id = this.namespace.idFromName("oauth-refresh:" + token.slice(0, 12));
    return this.namespace.get(id);
  }

  async begin(token: string, pendingTtlMs: number): Promise<RefreshBeginResult> {
    const response = await this.stubFor(token).fetch("https://auth-coordinator/refresh/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, pendingTtlMs })
    });
    if (!response.ok) {
      throw new Error("Authorization code coordinator failed to begin refresh rotation.");
    }
    return (await response.json()) as RefreshBeginResult;
  }

  async complete(token: string, replayTtlMs: number, responsePayload: RefreshReplayResponse): Promise<void> {
    const response = await this.stubFor(token).fetch("https://auth-coordinator/refresh/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, replayTtlMs, response: responsePayload })
    });
    if (response.status !== 204) {
      throw new Error("Authorization code coordinator failed to complete refresh rotation.");
    }
  }

  async fail(token: string): Promise<void> {
    const response = await this.stubFor(token).fetch("https://auth-coordinator/refresh/fail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token })
    });
    if (response.status !== 204) {
      throw new Error("Authorization code coordinator failed to clear refresh rotation state.");
    }
  }

  async clear(token: string): Promise<void> {
    const response = await this.stubFor(token).fetch("https://auth-coordinator/refresh/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token })
    });
    if (response.status !== 204) {
      throw new Error("Authorization code coordinator failed to clear refresh replay state.");
    }
  }
}
