import test from "node:test";
import assert from "node:assert/strict";
import { parseNormalizedPackage } from "../src/adapters/packageSchema.js";

const baseGithubPackage = {
  sourceType: "codex_v1",
  importMode: "github_import",
  title: "GitHub Vibe",
  github: {
    url: "https://github.com/BradenHartsell/Vibecodr-MCP"
  }
} as const;

test("GitHub imports accept only HTTPS github.com repository URLs", () => {
  const parsed = parseNormalizedPackage(baseGithubPackage);
  assert.equal(parsed.github?.url, "https://github.com/BradenHartsell/Vibecodr-MCP");
  const gitSuffix = parseNormalizedPackage({
    ...baseGithubPackage,
    github: { url: "https://www.github.com/BradenHartsell/Vibecodr-MCP.git" }
  });
  assert.equal(gitSuffix.github?.url, "https://www.github.com/BradenHartsell/Vibecodr-MCP.git");

  assert.throws(
    () => parseNormalizedPackage({
      ...baseGithubPackage,
      github: { url: "http://127.0.0.1:8080/repo" }
    }),
    /GitHub import URL must be an HTTPS github\.com repository URL/
  );

  assert.throws(
    () => parseNormalizedPackage({
      ...baseGithubPackage,
      github: { url: "https://github.com/BradenHartsell/Vibecodr-MCP/tree/main" }
    }),
    /GitHub import URL must be an HTTPS github\.com repository URL/
  );

  assert.throws(
    () => parseNormalizedPackage({
      ...baseGithubPackage,
      github: { url: "https://github.com/BradenHartsell/Vibecodr-MCP?ref=main" }
    }),
    /GitHub import URL must be an HTTPS github\.com repository URL/
  );
});
