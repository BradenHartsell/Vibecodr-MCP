import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { KvNamespaceLike } from "../storage/operationStoreKv.js";
import {
  RefreshReplayCoordinatorClient,
  type AuthorizationCodeCoordinatorNamespaceLike
} from "./authorizationCodeCoordinator.js";

type PersistedRefreshGrant = {
  jti: string;
  secretHash: string;
  client_id: string;
  provider_refresh_token: string;
  requested_scope: string;
  requested_resource?: string;
  created_at: number;
  expires_at: number;
  provider_refresh_expires_at?: number;
};

export type RefreshGrantRecord = Omit<PersistedRefreshGrant, "secretHash">;

export type RefreshGrantInput = {
  client_id: string;
  provider_refresh_token: string;
  requested_scope: string;
  requested_resource?: string;
  provider_refresh_expires_at?: number;
};

export type RefreshReplayResponse = {
  client_id: string;
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
};

const TOKEN_PREFIX = "vc_rt";
const MAX_REFRESH_GRANT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const REFRESH_PENDING_TTL_MS = 15_000;
const REFRESH_REPLAY_TTL_MS = 120_000;

type RefreshBeginState =
  | { state: "leader" }
  | { state: "wait" }
  | { state: "replay"; response: RefreshReplayResponse };

type InMemoryRefreshReplayRecord =
  | { kind: "pending"; expiresAt: number }
  | { kind: "replay"; expiresAt: number; response: RefreshReplayResponse };

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEquals(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

function computeExpiresAt(providerRefreshExpiresAt?: number): number {
  const now = Date.now();
  const cap = now + MAX_REFRESH_GRANT_TTL_MS;
  if (typeof providerRefreshExpiresAt === "number" && Number.isFinite(providerRefreshExpiresAt)) {
    return Math.max(now + 60_000, Math.min(providerRefreshExpiresAt, cap));
  }
  return cap;
}

export class OAuthRefreshStore {
  private readonly key: Buffer;
  private readonly replayCoordinator?: RefreshReplayCoordinatorClient;
  private readonly inMemoryReplay = new Map<string, InMemoryRefreshReplayRecord>();

  constructor(
    private readonly kv: KvNamespaceLike,
    signingKey: string,
    coordinationNamespace?: AuthorizationCodeCoordinatorNamespaceLike
  ) {
    this.key = createHash("sha256").update(signingKey + ":oauth-refresh").digest();
    this.replayCoordinator = coordinationNamespace ? new RefreshReplayCoordinatorClient(coordinationNamespace) : undefined;
  }

  async issue(input: RefreshGrantInput): Promise<string> {
    const jti = randomUUID();
    const secret = base64UrlEncode(randomBytes(32));
    const record: PersistedRefreshGrant = {
      jti,
      secretHash: stableHash(secret),
      client_id: input.client_id,
      provider_refresh_token: input.provider_refresh_token,
      requested_scope: input.requested_scope,
      requested_resource: input.requested_resource,
      created_at: Date.now(),
      expires_at: computeExpiresAt(input.provider_refresh_expires_at),
      provider_refresh_expires_at: input.provider_refresh_expires_at
    };
    await this.write(record);
    return this.formatToken(jti, secret);
  }

  async get(token: string): Promise<RefreshGrantRecord | null> {
    const parsed = this.parseToken(token);
    if (!parsed) return null;
    const record = await this.read(parsed.jti);
    if (!record) return null;
    if (record.expires_at < Date.now()) {
      await this.delete(record.jti);
      return null;
    }
    if (!safeEquals(record.secretHash, stableHash(parsed.secret))) return null;
    const { secretHash: _secretHash, ...grant } = record;
    return grant;
  }

  async replace(currentToken: string, input: RefreshGrantInput): Promise<string | null> {
    const current = await this.get(currentToken);
    if (!current) return null;
    const nextToken = await this.issue(input);
    await this.revoke(currentToken);
    return nextToken;
  }

  async revoke(token: string): Promise<RefreshGrantRecord | null> {
    const parsed = this.parseToken(token);
    if (!parsed) return null;
    const record = await this.read(parsed.jti);
    if (!record) return null;
    if (!safeEquals(record.secretHash, stableHash(parsed.secret))) return null;
    await this.delete(parsed.jti);
    await this.clearReplay(token);
    const { secretHash: _secretHash, ...grant } = record;
    return grant;
  }

  async beginRefresh(token: string): Promise<RefreshBeginState> {
    if (this.replayCoordinator) {
      return this.replayCoordinator.begin(token, REFRESH_PENDING_TTL_MS);
    }
    this.cleanupInMemoryReplay();
    const existing = this.inMemoryReplay.get(token);
    if (existing?.kind === "replay") {
      return { state: "replay", response: existing.response };
    }
    if (existing?.kind === "pending") {
      return { state: "wait" };
    }
    this.inMemoryReplay.set(token, {
      kind: "pending",
      expiresAt: Date.now() + REFRESH_PENDING_TTL_MS
    });
    return { state: "leader" };
  }

  async completeRefresh(token: string, response: RefreshReplayResponse): Promise<void> {
    if (this.replayCoordinator) {
      await this.replayCoordinator.complete(token, REFRESH_REPLAY_TTL_MS, response);
      return;
    }
    this.cleanupInMemoryReplay();
    this.inMemoryReplay.set(token, {
      kind: "replay",
      expiresAt: Date.now() + REFRESH_REPLAY_TTL_MS,
      response
    });
  }

  async failRefresh(token: string): Promise<void> {
    if (this.replayCoordinator) {
      await this.replayCoordinator.fail(token);
      return;
    }
    const existing = this.inMemoryReplay.get(token);
    if (existing?.kind === "pending") {
      this.inMemoryReplay.delete(token);
    }
  }

  async clearReplay(token: string): Promise<void> {
    if (this.replayCoordinator) {
      await this.replayCoordinator.clear(token);
      return;
    }
    this.inMemoryReplay.delete(token);
  }

  private keyFor(jti: string): string {
    return "oauth:refresh:" + jti;
  }

  private formatToken(jti: string, secret: string): string {
    return TOKEN_PREFIX + "." + jti + "." + secret;
  }

  private parseToken(token: string): { jti: string; secret: string } | null {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    const [, jti, secret] = parts;
    if (!jti || !secret) return null;
    return { jti, secret };
  }

  private seal(record: PersistedRefreshGrant): string {
    const plaintext = Buffer.from(JSON.stringify(record), "utf8");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return "v1." + base64UrlEncode(iv) + "." + base64UrlEncode(encrypted) + "." + base64UrlEncode(tag);
  }

  private unseal(value: string): PersistedRefreshGrant | null {
    if (!value.startsWith("v1.")) return null;
    const parts = value.split(".");
    if (parts.length !== 4) return null;
    const [, ivPart, encryptedPart, tagPart] = parts;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, base64UrlDecode(ivPart));
      decipher.setAuthTag(base64UrlDecode(tagPart));
      const plaintext = Buffer.concat([decipher.update(base64UrlDecode(encryptedPart)), decipher.final()]);
      const payload = JSON.parse(plaintext.toString("utf8")) as Partial<PersistedRefreshGrant>;
      if (
        typeof payload.jti !== "string" ||
        typeof payload.secretHash !== "string" ||
        typeof payload.client_id !== "string" ||
        typeof payload.provider_refresh_token !== "string" ||
        typeof payload.requested_scope !== "string" ||
        typeof payload.created_at !== "number" ||
        typeof payload.expires_at !== "number"
      ) {
        return null;
      }
      return payload as PersistedRefreshGrant;
    } catch {
      return null;
    }
  }

  private async write(record: PersistedRefreshGrant): Promise<void> {
    const ttlSeconds = Math.max(Math.ceil((record.expires_at - Date.now()) / 1000), 60);
    await this.kv.put(this.keyFor(record.jti), this.seal(record), { expirationTtl: ttlSeconds });
  }

  private async read(jti: string): Promise<PersistedRefreshGrant | null> {
    const raw = await this.kv.get(this.keyFor(jti), "text");
    if (!raw || typeof raw !== "string") return null;
    return this.unseal(raw);
  }

  private async delete(jti: string): Promise<void> {
    if (typeof this.kv.delete === "function") {
      await this.kv.delete(this.keyFor(jti));
    }
  }

  private cleanupInMemoryReplay(): void {
    const now = Date.now();
    for (const [token, record] of this.inMemoryReplay.entries()) {
      if (record.expiresAt < now) {
        this.inMemoryReplay.delete(token);
      }
    }
  }
}
