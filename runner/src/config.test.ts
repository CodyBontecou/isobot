import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredRepos, loadConfig, loadEnvironment, policyFor, validateConfig, type RunnerConfig } from "./config.js";

test("the shipped config is valid and starts every repo at pr autonomy", () => {
  const config = loadConfig();
  const repos = configuredRepos(config);
  assert.ok(repos.length >= 6);
  for (const { owner, repo } of repos) assert.equal(policyFor(config, `${owner}/${repo}`).autonomy, "pr");
  assert.equal(config.discordCategories["gitsync.md"], "codybontecou/GitSync.md");
  assert.equal(config.discordCategories["whereday"], "codybontecou/whereday");
});

test("repos not listed in the config are off", () => {
  const config = loadConfig();
  assert.equal(policyFor(config, "someone/else").autonomy, "off");
  assert.equal(policyFor(config, "CODYBONTECOU/TIME.MD").autonomy, "pr");
});

test("per-repo policy extends protected paths and overrides release", () => {
  const config = loadConfig();
  config.repos["codybontecou/time.md"] = { protectedPaths: ["db/**"], release: { onMerge: ["make deploy"], onShip: [] } };
  const policy = policyFor(config, "codybontecou/time.md");
  assert.ok(policy.protectedPaths.includes(".github/**"));
  assert.ok(policy.protectedPaths.includes("db/**"));
  assert.deepEqual(policy.release.onMerge, ["make deploy"]);
});

test("merge autonomy without checks is rejected", () => {
  const config: RunnerConfig = loadConfig();
  config.repos["codybontecou/time.md"] = { autonomy: "merge" };
  assert.throws(() => validateConfig(config), /needs at least one check command/);
  config.repos["codybontecou/time.md"] = { autonomy: "merge", checks: ["make test"] };
  assert.doesNotThrow(() => validateConfig(config));
});

test("unknown autonomy levels are rejected", () => {
  const config = loadConfig();
  config.repos["codybontecou/time.md"] = { autonomy: "yolo" as never };
  assert.throws(() => validateConfig(config), /unknown autonomy/);
});

test("environment requires a GitHub token and HTTPS Pi URL", () => {
  assert.throws(() => loadEnvironment({}), /GITHUB_TOKEN/);
  assert.throws(() => loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_PI_URL: "http://pi.example.com" }), /HTTPS/);
  const env = loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_PI_URL: "https://pi.isolated.tech/", ISOBOT_HOME: "/tmp/x" });
  assert.equal(env.piUrl, "https://pi.isolated.tech");
  assert.equal(env.home, "/tmp/x");
  assert.equal(env.imap, undefined);
});

test("vox config is validated", () => {
  const ok = { ...loadConfig(), vox: { conversation: "isobot", autoApprove: true } } as RunnerConfig;
  assert.doesNotThrow(() => validateConfig(ok));
  assert.throws(() => validateConfig({ ...ok, vox: { conversation: "../x", autoApprove: true } }), /vox.conversation/);
  assert.throws(() => validateConfig({ ...ok, vox: { conversation: "isobot", autoApprove: "yes" } } as unknown as RunnerConfig), /vox.autoApprove/);
  assert.throws(() => validateConfig({ ...ok, vox: { conversation: "isobot", autoApprove: true, minAutoApproveConfidence: 0 } }), /minAutoApproveConfidence/);
  assert.throws(() => validateConfig({ ...ok, vox: { conversation: "isobot", autoApprove: true, maxProposalsPerNote: 0 } }), /maxProposalsPerNote/);
});
