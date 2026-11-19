import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, type OutboundContext } from "./policy.js";

const ctx: OutboundContext = { repo: "codybontecou/health-md", claudeToken: "real-claude", githubToken: "real-github" };
const at = (url: string, c = ctx) => decide(new URL(url), c);

test("Anthropic API requests get the real Claude token in place of whatever the Container sent", () => {
  assert.deepEqual(at("https://api.anthropic.com/v1/messages"), { action: "forward", setHeaders: { authorization: "Bearer real-claude" }, deleteHeaders: ["x-api-key"] });
  assert.equal(at("https://api.anthropic.com/v1/messages", { ...ctx, claudeToken: undefined }).action, "deny");
});

test("git reads the job's own repository with the Worker's token, case-insensitively, with or without .git", () => {
  const basic = { authorization: `Basic ${btoa("x-access-token:real-github")}` };
  assert.deepEqual(at("https://github.com/codybontecou/health-md.git/info/refs?service=git-upload-pack"), { action: "forward", setHeaders: basic, deleteHeaders: [] });
  assert.deepEqual(at("https://github.com/CodyBontecou/health-md/git-upload-pack"), { action: "forward", setHeaders: basic, deleteHeaders: [] });
});

test("other repositories are fetched without credentials", () => {
  assert.deepEqual(at("https://github.com/codybontecou/vox.md.git/git-upload-pack"), { action: "forward", setHeaders: {}, deleteHeaders: ["authorization"] });
});

test("pushes are refused, to the job's repository and any other", () => {
  for (const url of [
    "https://github.com/codybontecou/health-md.git/info/refs?service=git-receive-pack",
    "https://github.com/codybontecou/health-md.git/git-receive-pack",
    "https://github.com/someone/else/git-receive-pack",
  ]) assert.equal(at(url).action, "deny", url);
});

test("plain HTTP is refused, and other hosts get no credentials", () => {
  assert.equal(at("http://registry.npmjs.org/astro").action, "deny");
  assert.deepEqual(at("https://registry.npmjs.org/astro"), { action: "forward", setHeaders: {}, deleteHeaders: ["authorization", "proxy-authorization", "cookie"] });
  assert.deepEqual(at("https://api.github.com/user"), { action: "forward", setHeaders: {}, deleteHeaders: ["authorization", "proxy-authorization", "cookie"] });
});
