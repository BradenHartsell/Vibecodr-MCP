import test from "node:test";
import assert from "node:assert/strict";
import { VibecodrClient, coverUsageForVisibility } from "../src/vibecodr/client.js";

const userContext = {
  userId: "user_123",
  userHandle: "braden",
  vibecodrToken: "token_abc"
};

test("coverUsageForVisibility matches Vibecodr's cover lanes", () => {
  assert.equal(coverUsageForVisibility("public"), "app_cover");
  assert.equal(coverUsageForVisibility("unlisted"), "app_cover");
  assert.equal(coverUsageForVisibility("private"), "standalone");
  assert.equal(coverUsageForVisibility(undefined), "app_cover");
});

test("uploadCover targets the requested usage lane", async () => {
  let requestedUrl = "";
  const client = new VibecodrClient(
    "https://api.vibecodr.space",
    async (input, init) => {
      requestedUrl = String(input);
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ key: "covers/user/key.png", usage: "standalone" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }
  );

  const result = await client.uploadCover(
    userContext,
    {
      contentType: "image/png",
      fileBytes: new Uint8Array([1, 2, 3]),
      usage: "standalone"
    }
  );

  assert.match(requestedUrl, /\/covers\?usage=standalone$/);
  assert.equal(result.key, "covers/user/key.png");
  assert.equal(result.usage, "standalone");
});

test("getAccountCapabilities no longer depends on /me/profile", async () => {
  const seenPaths: string[] = [];
  const client = new VibecodrClient(
    "https://api.vibecodr.space",
    async (input) => {
      const url = new URL(String(input));
      seenPaths.push(url.pathname);
      if (url.pathname === "/user/quota") {
        return new Response(
          JSON.stringify({
            plan: "creator",
            usage: {
              storage: 0,
              runs: 0,
              bundleSize: 0,
              serverActionRuns: 0,
              serverActionCount: 0,
              webhookCalls: 0
            },
            limits: {
              maxStorage: 1,
              maxRuns: "unlimited",
              maxPrivateVibes: 10,
              maxConnections: 10,
              serverActions: { maxActions: 5, maxRunsPerMonth: 100, maxRuntimeMs: 30000 },
              pulses: {
                maxActions: 3,
                maxRunsPerMonth: 200,
                maxRuntimeMs: 30000,
                maxPrivatePulses: 3,
                maxSubrequests: 50,
                maxVanitySubdomains: 1,
                proxyRateLimit: 60,
                secretsProxyOwnerRateLimit: 60,
                secretsProxyPulseRateLimit: 60
              },
              webhookActions: { maxActions: 2, maxCallsPerMonth: 50 },
              features: {
                customSeo: true,
                serverActionsEnabled: true,
                pulsesEnabled: true,
                webhookActionsEnabled: true,
                embedsUnbranded: false,
                customDomains: 0,
                d1SqlEnabled: true,
                secretsStoreEnabled: true,
                canPublishLibraryVibes: true,
                advancedZipAnalysis: true,
                studioParamsTab: true,
                studioFilesTab: true
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error("Unexpected path: " + url.pathname);
    }
  );

  const account = await client.getAccountCapabilities(userContext);

  assert.deepEqual(seenPaths, ["/user/quota"]);
  assert.equal(account.profile.handle, "braden");
  assert.equal(account.quota.plan, "creator");
});

test("discoverVibes reads the homepage latest feed lane", async () => {
  let requestedUrl = "";
  const client = new VibecodrClient(
    "https://api.vibecodr.space",
    async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ posts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  );

  const vibes = await client.discoverVibes({ limit: 7, offset: 3, query: "music toys" });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/feed/discover");
  assert.equal(url.searchParams.get("mode"), "latest");
  assert.equal(url.searchParams.get("surface"), "feed");
  assert.equal(url.searchParams.get("limit"), "7");
  assert.equal(url.searchParams.get("offset"), "3");
  assert.equal(url.searchParams.get("q"), "music toys");
  assert.deepEqual(vibes, []);
});

test("searchVibecodr normalizes public type aliases and returns absolute urls", async () => {
  let requestedUrl = "";
  const client = new VibecodrClient(
    "https://api.vibecodr.space",
    async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          results: [
            { type: "user", id: "user_1", handle: "vibecodr", url: "/u/vibecodr" },
            { type: "post", id: "post_1", title: "Hello", url: "/post/post_1" }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  );

  const results = await client.searchVibecodr({
    query: "vibecodr",
    types: "posts, profiles, tags, vibes, handles",
    limit: 5
  });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("types"), "post,user,tag");
  assert.equal(results[0]?.type, "profile");
  assert.equal(results[0]?.url, "https://vibecodr.space/u/vibecodr");
  assert.equal(results[1]?.url, "https://vibecodr.space/post/post_1");
});

test("searchVibecodr rejects mixed unsupported social type filters without touching the API", async () => {
  const client = new VibecodrClient(
    "https://api.vibecodr.space",
    async () => {
      throw new Error("API should not be called for mixed unsupported filters");
    }
  );

  await assert.rejects(
    client.searchVibecodr({ query: "comments", types: "posts,threads,capsules" }),
    /Unsupported search type filter/
  );
});

test("searchVibecodr rejects unsupported-only social type filters without touching the API", async () => {
  const client = new VibecodrClient(
    "https://api.vibecodr.space",
    async () => {
      throw new Error("API should not be called for unsupported-only filters");
    }
  );

  await assert.rejects(
    client.searchVibecodr({ query: "comments", types: "threads,capsules" }),
    /Unsupported search type filter/
  );
});
