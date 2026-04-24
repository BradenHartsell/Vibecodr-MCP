import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type OauthStateRecord = {
  state: string;
  codeVerifier: string;
  createdAt: number;
  returnTo: string;
};

type OauthStatePayload = {
  nonce: string;
  cv: string;
  rt: string;
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

export class OauthStateStore {
  private readonly signingKey: string;
  private readonly ttlMs: number;
  private readonly usedNonces = new Map<string, number>();

  constructor(signingKey: string, ttlMs = 10 * 60 * 1000) {
    this.signingKey = signingKey;
    this.ttlMs = ttlMs;
  }

  create(codeVerifier: string, returnTo: string): OauthStateRecord {
    this.cleanup();
    const now = Date.now();
    const payload: OauthStatePayload = {
      nonce: randomUUID(),
      cv: codeVerifier,
      rt: returnTo || "/",
      iat: now,
      exp: now + this.ttlMs
    };
    const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = this.sign(encoded);
    return {
      state: encoded + "." + sig,
      codeVerifier: payload.cv,
      createdAt: payload.iat,
      returnTo: payload.rt
    };
  }

  consume(stateToken: string): OauthStateRecord | null {
    this.cleanup();
    const [encoded, sig] = stateToken.split(".");
    if (!encoded || !sig) return null;

    if (!this.verify(encoded, sig)) return null;

    let payload: Partial<OauthStatePayload>;
    try {
      payload = JSON.parse(base64UrlDecode(encoded).toString("utf8")) as Partial<OauthStatePayload>;
    } catch {
      return null;
    }

    if (
      typeof payload.nonce !== "string" ||
      typeof payload.cv !== "string" ||
      typeof payload.rt !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }

    const now = Date.now();
    if (payload.exp < now) return null;

    // One-time use per instance to reduce replay risk.
    if (this.usedNonces.has(payload.nonce)) return null;
    this.usedNonces.set(payload.nonce, payload.exp);

    return {
      state: stateToken,
      codeVerifier: payload.cv,
      createdAt: payload.iat,
      returnTo: payload.rt
    };
  }

  private sign(encodedPayload: string): string {
    return createHmac("sha256", this.signingKey).update(encodedPayload).digest("hex");
  }

  private verify(encodedPayload: string, signature: string): boolean {
    const expected = this.sign(encodedPayload);
    const provided = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (provided.length !== expBuf.length) return false;
    return timingSafeEqual(provided, expBuf);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [nonce, exp] of this.usedNonces.entries()) {
      if (exp < now) this.usedNonces.delete(nonce);
    }
  }
}

