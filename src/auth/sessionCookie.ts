export const SESSION_COOKIE_NAME = "__Host-vc_session";
export const LEGACY_SESSION_COOKIE_NAME = "vc_session";

export function writeSessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_NAME : LEGACY_SESSION_COOKIE_NAME;
}

function readCookieValue(cookieHeader: string, name: string): string | undefined {
  const prefix = name + "=";
  const token = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!token) return undefined;
  try {
    return decodeURIComponent(token.slice(prefix.length));
  } catch {
    return undefined;
  }
}

export function readSessionCookie(cookieHeader: string): { value?: string | undefined; legacy: boolean } {
  const hostCookie = readCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  if (hostCookie) return { value: hostCookie, legacy: false };

  const legacyCookie = readCookieValue(cookieHeader, LEGACY_SESSION_COOKIE_NAME);
  return { value: legacyCookie, legacy: Boolean(legacyCookie) };
}
