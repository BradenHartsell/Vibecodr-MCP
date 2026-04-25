import test from "node:test";
import assert from "node:assert/strict";
import { exchangeProviderAccessForVibecodr } from "../src/auth/vibecodrTokenExchange.js";
import { readSessionCookie } from "../src/auth/sessionCookie.js";
import { translateFailure } from "../src/lib/failureTranslation.js";
import { parseCookies } from "../src/lib/http.js";

test("Vibecodr bearer exchange failures do not expose raw upstream bodies", async () => {
  await assert.rejects(
    exchangeProviderAccessForVibecodr(
      "provider-token",
      "https://api.vibecodr.space",
      async () => new Response("<html>debug access_token=secret-refresh-token</html>", { status: 502 })
    ),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.doesNotMatch(JSON.stringify(error), /secret-refresh-token|access_token|<html>/i);
      return true;
    }
  );
});

test("failure translation keeps raw upstream details out of public summaries", () => {
  const translated = translateFailure("INGEST_FAILED", "failed", {
    upstreamStatus: 502,
    upstreamPath: "/capsules/empty",
    upstreamMessage: "<html>debug refresh_token=secret-refresh-token</html>",
    rawMessage: "Bearer secret-refresh-token"
  });
  const serialized = JSON.stringify(translated);

  assert.match(translated.rootCauseSummary || "", /upstream service returned 502/i);
  assert.doesNotMatch(serialized, /secret-refresh-token|refresh_token|Bearer|<html>/i);
});

test("malformed cookie encoding is ignored instead of crashing auth parsing", () => {
  assert.deepEqual(readSessionCookie("__Host-vc_session=%"), { value: undefined, legacy: false });
  assert.deepEqual(parseCookies(new Request("https://openai.vibecodr.space", {
    headers: { cookie: "__Host-vc_session=%; other=ok" }
  })), { other: "ok" });
});
