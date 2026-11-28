import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredRepos, loadConfig, loadEnvironment, policyFor, validateConfig, type RunnerConfig } from "./config.js";

test("the shipped config is valid and lets every app repo merge behind its checks", () => {
  const config = loadConfig();
  const repos = configuredRepos(config);
  assert.ok(repos.length >= 7);
  for (const { owner, repo } of repos) {
    const policy = policyFor(config, `${owner}/${repo}`);
    // isobot itself only opens PRs: the owner merges every change to the runner.
    assert.equal(policy.autonomy, repo === "isobot" ? "pr" : "merge");
    if (repo === "isobot") assert.equal(policy.ownerAutonomy, "pr");
    assert.ok(policy.checks.length > 0);
    assert.ok(policy.requireCi);
  }
  assert.equal(config.discordCategories["gitsync.md"], "codybontecou/GitSync.md");
  assert.equal(config.discordCategories["whereday"], "codybontecou/whereday");
});

test("repos not listed in the config are off", () => {
  const config = loadConfig();
  assert.equal(policyFor(config, "someone/else").autonomy, "off");
  assert.equal(policyFor(config, "CODYBONTECOU/TIME.MD").autonomy, "merge");
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
  assert.throws(() => loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_HEARTBEAT_URL: "http://hc.example/ping" }), /HEARTBEAT_URL must use HTTPS/);
  assert.equal(loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_HEARTBEAT_URL: " https://hc.example/ping " }).heartbeatUrl, "https://hc.example/ping");
  assert.equal(loadEnvironment({ GITHUB_TOKEN: "t" }).heartbeatUrl, undefined);
  assert.equal(loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_RUNNER_ID: " mac mini " }).runnerId, "mac-mini");
  assert.match(loadEnvironment({ GITHUB_TOKEN: "t" }).runnerId, /^[\w.-]+$/);
  assert.equal(loadEnvironment({ GITHUB_TOKEN: "t" }).role, "primary");
  assert.equal(loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_RUNNER_ROLE: " Builder " }).role, "builder");
  assert.equal(loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_RUNNER_ROLE: "builds" }).role, "builder");
  assert.throws(() => loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_RUNNER_ROLE: "worker" }), /ISOBOT_RUNNER_ROLE/);
  assert.throws(() => loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_RUNNER_ROLE: "auto" }), /needs ISOBOT_HEARTBEAT_URL/);
  const auto = loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_RUNNER_ROLE: "auto", ISOBOT_HEARTBEAT_URL: "https://w.example/ping/abc", ISOBOT_LEADER_PREFERRED: "1" });
  assert.equal(auto.role, "auto");
  assert.equal(auto.leaderPreferred, true);
  assert.equal(loadEnvironment({ GITHUB_TOKEN: "t" }).leaderPreferred, false);
  const env = loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_PI_URL: "https://pi.isolated.tech/", ISOBOT_HOME: "/tmp/x" });
  assert.equal(env.piUrl, "https://pi.isolated.tech");
  assert.equal(env.home, "/tmp/x");
  assert.deepEqual(env.imap, []);
});

test("vox config is validated", () => {
  const ok = { ...loadConfig(), vox: { conversation: "isobot", autoApprove: true } } as RunnerConfig;
  assert.doesNotThrow(() => validateConfig(ok));
  assert.throws(() => validateConfig({ ...ok, vox: { conversation: "../x", autoApprove: true } }), /vox.conversation/);
  assert.throws(() => validateConfig({ ...ok, vox: { conversation: "isobot", autoApprove: "yes" } } as unknown as RunnerConfig), /vox.autoApprove/);
  assert.throws(() => validateConfig({ ...ok, vox: { conversation: "isobot", autoApprove: true, minAutoApproveConfidence: 0 } }), /minAutoApproveConfidence/);
  assert.throws(() => validateConfig({ ...ok, vox: { conversation: "isobot", autoApprove: true, maxProposalsPerNote: 0 } }), /maxProposalsPerNote/);
});

test("App Store config is validated", () => {
  const config = loadConfig();
  assert.equal(config.appStore?.apps["6758960270"], "codybontecou/GitSync.md");
  const ok = { ...config, appStore: { apps: { "123456": "codybontecou/vox.md" }, countries: ["us"] } } as RunnerConfig;
  assert.doesNotThrow(() => validateConfig(ok));
  assert.throws(() => validateConfig({ ...ok, appStore: { apps: {}, countries: ["us"] } }), /at least one app/);
  assert.throws(() => validateConfig({ ...ok, appStore: { apps: { "vox": "codybontecou/vox.md" }, countries: ["us"] } }), /numeric App Store id/);
  assert.throws(() => validateConfig({ ...ok, appStore: { apps: { "123456": "vox.md" }, countries: ["us"] } }), /owner\/repo/);
  assert.throws(() => validateConfig({ ...ok, appStore: { apps: { "123456": "codybontecou/vox.md" }, countries: ["USA"] } }), /country codes/);
});

test("ownerAutonomy merge needs checks, like autonomy merge", () => {
  const config = loadConfig();
  config.repos["codybontecou/time.md"] = { autonomy: "pr", ownerAutonomy: "merge", checks: [] };
  assert.throws(() => validateConfig(config), /ownerAutonomy "merge" needs at least one check command/);
  config.repos["codybontecou/time.md"] = { autonomy: "pr", ownerAutonomy: "merge", checks: ["make test"] };
  assert.doesNotThrow(() => validateConfig(config));
});

test("several mailboxes load from numbered IMAP variables, Gmail by default", () => {
  const env = loadEnvironment({
    GITHUB_TOKEN: "t",
    ISOBOT_IMAP_USER: "a@gmail.com", ISOBOT_IMAP_PASSWORD: "abcd efgh ijkl mnop",
    ISOBOT_IMAP_USER_2: "b@example.com", ISOBOT_IMAP_PASSWORD_2: "x", ISOBOT_IMAP_HOST_2: "imap.example.com",
    ISOBOT_IMAP_USER_3: "c@gmail.com",
  });
  assert.deepEqual(env.imap, [
    { host: "imap.gmail.com", port: 993, user: "a@gmail.com", password: "abcdefghijklmnop", mailbox: "INBOX", query: "-from:me (category:primary OR to:isolated.tech)" },
    { host: "imap.example.com", port: 993, user: "b@example.com", password: "x", mailbox: "INBOX", query: "" },
  ], "an account without a password is skipped");
  assert.throws(() => loadEnvironment({ GITHUB_TOKEN: "t", ISOBOT_IMAP_USER: "a@example.com", ISOBOT_IMAP_PASSWORD: "x" }), /ISOBOT_IMAP_HOST/);
});
