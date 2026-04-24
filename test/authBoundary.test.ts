import test from "node:test";
import assert from "node:assert/strict";
import { exchangeProviderAccessForVibecodr } from "../src/auth/vibecodrTokenExchange.js";
import { translateFailure } from "../src/lib/failureTranslation.js";

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
