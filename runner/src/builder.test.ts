import assert from "node:assert/strict";
import { test } from "node:test";
import { builderSettings, defaultDenyPaths, parseResult, parseReview, parseTriage } from "./builder.js";

test("parses the CLI's JSON result, including after stray diagnostics", () => {
  const payload = { type: "result", subtype: "success", is_error: false, session_id: "s1", result: "done", structured_output: { a: 1 } };
  assert.deepEqual(parseResult(JSON.stringify(payload)), payload);
  assert.deepEqual(parseResult(`warning: something\n${JSON.stringify(payload)}`), payload);
  assert.equal(parseResult(""), null);
  assert.equal(parseResult("not json"), null);
});

test("an invalid review is a high-risk rejection, never an approval", () => {
  assert.deepEqual(parseReview(undefined).verdict, "request_changes");
  assert.equal(parseReview({ verdict: "approve" }).confidence, 0);
  assert.equal(parseReview({ verdict: "approve", confidence: 3, risk: "weird" }).confidence, 1);
  assert.equal(parseReview({ verdict: "approve", confidence: 0.9, risk: "weird" }).risk, "high");
});

test("triage keeps only known items and repositories", () => {
  const result = parseTriage({
    decisions: [
      { id: "discord:1", action: "propose", repo: "codybontecou/time.md", kind: "bug", scope: "small", title: "Crash", spec: "Fix it", confidence: 0.8, reason: "clear" },
      { id: "discord:2", action: "propose", repo: "evil/repo", kind: "feature", scope: "small", title: "X", spec: "Y", confidence: 0.9, reason: "" },
      { id: "made-up", action: "propose", repo: "codybontecou/time.md", kind: "bug", scope: "small", title: "X", spec: "Y", confidence: 1, reason: "" },
      { id: "discord:3", action: "propose", repo: "codybontecou/time.md", kind: "bug", scope: "small", title: " ", spec: "Y", confidence: 1, reason: "" },
    ],
    digest: "summary",
  }, new Set(["discord:1", "discord:2", "discord:3"]), new Set(["codybontecou/time.md"]));
  assert.deepEqual(result.decisions.map(d => [d.id, d.action]), [["discord:1", "propose"], ["discord:2", "ignore"], ["discord:3", "ignore"]]);
  assert.equal(result.digest, "summary");
});

test("builder settings sandbox the shell and deny secrets with absolute rule paths", () => {
  const settings = builderSettings({ sandbox: { filesystem: { allowWrite: ["/extra"] } } }, { secrets: ["/state/runner.env"], noWrite: ["/code/isobot"] }, "/Users/me") as {
    sandbox: { enabled: boolean; allowUnsandboxedCommands: boolean; filesystem: { allowWrite: string[]; denyRead: string[]; denyWrite: string[] } };
    permissions: { deny: string[] };
  };
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.ok(settings.sandbox.filesystem.allowWrite.includes("/extra"));
  assert.ok(settings.sandbox.filesystem.allowWrite.includes("/Users/me/Library/Developer/Xcode/DerivedData"));
  assert.ok(settings.sandbox.filesystem.denyRead.includes("/state/runner.env"));
  assert.ok(settings.sandbox.filesystem.denyWrite.includes("/code/isobot"));
  assert.ok(settings.permissions.deny.includes("Read(//Users/me/.ssh/**)"), "absolute paths need the // prefix");
  assert.ok(settings.permissions.deny.includes("Read(//state/runner.env)"));
  assert.ok(settings.permissions.deny.includes("Edit(//Users/me/.claude/**)"));
  assert.ok(settings.permissions.deny.includes("Write(//code/isobot/**)"));
  assert.ok(!settings.permissions.deny.some(rule => /\((?!\/\/)\//.test(rule)), "no single-slash (settings-relative) rules");
});

test("credential folders are denied to builders", () => {
  const deny = defaultDenyPaths("/Users/me");
  assert.ok(deny.includes("/Users/me/.ssh"));
  assert.ok(deny.includes("/Users/me/.config/gh"));
  assert.ok(deny.includes("/Users/me/Library/Keychains"));
});

test("triage scope defaults to major unless the model says small", () => {
  const result = parseTriage({
    decisions: [
      { id: "a", action: "propose", repo: "o/r", kind: "bug", scope: "small", title: "A", spec: "s", confidence: 1, reason: "" },
      { id: "b", action: "propose", repo: "o/r", kind: "bug", title: "B", spec: "s", confidence: 1, reason: "" },
      { id: "c", action: "propose", repo: "o/r", kind: "bug", scope: "tiny", title: "C", spec: "s", confidence: 1, reason: "" },
    ],
    digest: "",
  }, new Set(["a", "b", "c"]), new Set(["o/r"]));
  assert.deepEqual(result.decisions.map(d => d.scope), ["small", "major", "major"]);
});
