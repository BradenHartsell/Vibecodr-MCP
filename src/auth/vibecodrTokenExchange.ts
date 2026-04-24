import { VIBECDR_GRANT_PROFILE } from "./vibecodrGrantProfile.js";

type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type VibecodrExchangePayload = {
  access_token?: string;
  user_id?: string;
  user_handle?: string;
  expires_at?: number;
};

export async function exchangeProviderAccessForVibecodr(
  accessToken: string,
  vibecodrApiBase: string,
  httpFetch: HttpFetch = fetch,
  traceId?: string
): Promise<VibecodrExchangePayload> {
  const response = await httpFetch(vibecodrApiBase.replace(/\/+$/, "") + "/auth/cli/exchange", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(traceId ? { "x-trace-id": traceId } : {})
    },
    body: JSON.stringify({ access_token: accessToken, grant_profile: VIBECDR_GRANT_PROFILE })
  });

  const rawText = await response.text();
  let payload: VibecodrExchangePayload = {};
  try {
    payload = rawText ? (JSON.parse(rawText) as VibecodrExchangePayload) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw Object.assign(new Error("Vibecodr CLI exchange failed"), {
      code: "VIBECDR_CLI_EXCHANGE_FAILED",
      status: response.status
    });
  }

  if (typeof payload.access_token !== "string" || typeof payload.user_id !== "string") {
    throw Object.assign(new Error("Invalid CLI exchange response from Vibecodr"), {
      code: "INVALID_VIBECDR_EXCHANGE_RESPONSE"
    });
  }

  return payload;
}
