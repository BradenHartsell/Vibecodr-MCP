import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { SessionRecord } from "../types.js";
import type { SessionRevocationStore } from "./sessionRevocationStore.js";

type SessionPayload = {
  sid: string;
  uid: string;
  uh?: string | undefined;
  tok: string;
  iat: number;
  exp: number;
};

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

export class SessionStore {
  private readonly key: Buffer;
  private readonly pending = new Map<string, SessionRecord>();

  constructor(
    signingKey: string,
    private readonly revocationStore?: SessionRevocationStore
  ) {
    this.key = createHash("sha256").update(signingKey).digest();
  }

  create(userId: string, vibecodrToken: string, ttlSec = 60 * 60 * 12, userHandle?: string): SessionRecord {
    const now = Date.now();
    const rec: SessionRecord = {
      sessionId: randomUUID(),
      userId,
      ...(userHandle ? { userHandle } : {}),
      vibecodrToken,
      createdAt: now,
      expiresAt: now + ttlSec * 1000
    };
    this.pending.set(rec.sessionId, rec);
    return rec;
  }

  issue(userId: string, vibecodrToken: string, ttlSec = 60 * 60 * 12, userHandle?: string): {
    session: SessionRecord;
    signedToken: string;
  } {
    const session = this.create(userId, vibecodrToken, ttlSec, userHandle);
    return {
      session,
      signedToken: this.signSessionId(session.sessionId)
    };
  }

  signSessionId(sessionId: string): string {
    const rec = this.pending.get(sessionId);
    if (!rec) throw new Error("Session not found for signing");
    this.pending.delete(sessionId);
    return this.seal(rec);
  }

  private seal(rec: SessionRecord): string {
    const payload: SessionPayload = {
      sid: rec.sessionId,
      uid: rec.userId,
      ...(rec.userHandle ? { uh: rec.userHandle } : {}),
      tok: rec.vibecodrToken,
      iat: rec.createdAt,
      exp: rec.expiresAt
    };
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return "v1." + base64UrlEncode(iv) + "." + base64UrlEncode(encrypted) + "." + base64UrlEncode(tag);
  }

  getBySigned(signed: string): SessionRecord | null {
    if (!signed.startsWith("v1.")) return null;
    const parts = signed.split(".");
    if (parts.length !== 4) return null;

    const ivPart = parts[1];
    const encryptedPart = parts[2];
    const tagPart = parts[3];
    if (!ivPart || !encryptedPart || !tagPart) return null;
    try {
      const iv = base64UrlDecode(ivPart);
      const encrypted = base64UrlDecode(encryptedPart);
      const tag = base64UrlDecode(tagPart);

      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);

      const payload = JSON.parse(plaintext.toString("utf8")) as Partial<SessionPayload>;
      if (
        typeof payload.sid !== "string" ||
        typeof payload.uid !== "string" ||
        typeof payload.tok !== "string" ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number"
      ) {
        return null;
      }

      if (payload.exp < Date.now()) return null;

      return {
        sessionId: payload.sid,
        userId: payload.uid,
        ...(typeof payload.uh === "string" && payload.uh ? { userHandle: payload.uh } : {}),
        vibecodrToken: payload.tok,
        createdAt: payload.iat,
        expiresAt: payload.exp
      };
    } catch {
      return null;
    }
  }

  async getActiveBySigned(signed: string): Promise<SessionRecord | null> {
    const session = this.getBySigned(signed);
    if (!session) return null;
    if (this.revocationStore && await this.revocationStore.isRevoked(session.sessionId)) {
      return null;
    }
    return session;
  }

  async deleteBySigned(signed: string): Promise<void> {
    if (!this.revocationStore) return;
    const session = this.getBySigned(signed);
    if (!session) return;
    await this.revocationStore.revoke(session.sessionId, session.expiresAt);
  }
}

