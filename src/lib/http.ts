import { createHash } from "node:crypto";

type CookieOpts = {
  secure?: boolean;
};

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super("Request body exceeds configured limit.");
    this.name = "RequestBodyTooLargeError";
  }
}

export { RequestBodyTooLargeError as RequestBodyLimitError };

export function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(headers || {})
    }
  });
}

export function textResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(headers || {})
    }
  });
}

export function htmlResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(headers || {})
    }
  });
}

export async function readText(req: Request, maxBytes?: number): Promise<string> {
  if (maxBytes == null) return req.text();
  if (req.bodyUsed) {
    throw new Error("Request body has already been consumed.");
  }
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }
  if (!req.body) return "";

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("body limit exceeded");
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

export async function readTextWithLimit(req: Request, maxBytes: number): Promise<string> {
  return readText(req, maxBytes);
}

export async function readJson<T>(req: Request, maxBytes?: number): Promise<T> {
  const text = await readText(req, maxBytes);
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

export async function readForm(req: Request, maxBytes?: number): Promise<URLSearchParams> {
  return new URLSearchParams(await readText(req, maxBytes));
}

export async function readFormUrlEncoded(req: Request, maxBytes?: number): Promise<URLSearchParams> {
  return new URLSearchParams(await readText(req, maxBytes));
}

export function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.get("cookie");
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(rest.join("=") || "");
    } catch {
      continue;
    }
  }
  return out;
}

function cookieAttrSecure(opts?: CookieOpts): string {
  return opts?.secure ? "; Secure" : "";
}

export function setCookieHeader(name: string, value: string, maxAgeSec: number, opts?: CookieOpts): string {
  return (
    name +
    "=" +
    encodeURIComponent(value) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
    maxAgeSec +
    cookieAttrSecure(opts)
  );
}

export function clearCookieHeader(name: string, opts?: CookieOpts): string {
  return name + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + cookieAttrSecure(opts);
}

export async function toNodeResponse(res: Response, nodeRes: import("node:http").ServerResponse): Promise<void> {
  nodeRes.statusCode = res.status;
  res.headers.forEach((value, key) => nodeRes.setHeader(key, value));
  const buf = Buffer.from(await res.arrayBuffer());
  nodeRes.end(buf);
}

export function inferUserIdFromToken(token: string): string {
  const fragment = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return "token_user_" + fragment;
}

