import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, type RunnerConfig } from "./config.js";
import { Notifier } from "./notify.js";
import { buildTask, Pipeline, slug } from "./pipeline.js";
import type { CheckReport } from "./policy.js";
import { Store } from "./store.js";
import { FakeBuilder, FakeGitHub, FakeRepo } from "./testing.js";

const REPO = "codybontecou/time.md";
const [OWNER, NAME] = REPO.split("/");

function setup(configure: (config: RunnerConfig) => void = () => {}, checks: CheckReport[] = []) {
  const config = loadConfig();
  configure(config);
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  const builder = new FakeBuilder();
  const repo = new FakeRepo();
  const checkCalls: string[][] = [];
  const pipeline = new Pipeline({
    config, env: { home: "/tmp/isobot-test" }, store, github, builder, notifier: new Notifier(),
    repo: () => repo,
    checks: async (_cwd, commands) => {
      checkCalls.push(commands);
      return checks.shift() ?? { configured: commands.length > 0, passed: true, results: commands.map(command => ({ command, ok: true, output: "" })) };
    },
    sleep: async () => {},
  });
  return { config, store, github, builder, repo, pipeline, checkCalls };
}

async function cycle(pipeline: Pipeline) {
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
}

test("pr autonomy: claims the issue, builds, reviews and opens a PR for a human", async () => {
  const { github, pipeline, store, repo } = setup();
  github.add(OWNER, NAME, 7, "Add CSV export", ["isobot:ready"]);
  await cycle(pipeline);

  const issue = github.get(OWNER, NAME, 7);
  assert.deepEqual(issue.labels, ["isobot:review"]);
  const job = store.get("codybontecou/time.md#7")!;
  assert.equal(job.state, "pr_open");
  assert.equal(job.prNumber, 100);
  const pr = github.pulls.get(100)!;
  assert.equal(pr.branch, "isobot/7-add-csv-export");
  assert.match(pr.body, /Closes #7/);
  assert.match(pr.body, /approve\*\* · confidence 0.95/);
  assert.equal(github.merged.length, 0);
  assert.ok(repo.calls.includes("push isobot/7-add-csv-export"));
  assert.ok(repo.calls.includes("remove isobot/7-add-csv-export"), "worktree is cleaned up");
  const comments = github.commentsFor(OWNER, NAME, 7);
  assert.match(comments[0], /picked this up/);
  assert.match(comments.at(-1)!, /leaving the merge to you:\n- repository autonomy is "pr"/);
});

test("merge autonomy: merges when checks, review and policy pass, then releases and waits to ship", async () => {
  const { github, pipeline, store, repo } = setup(config => {
    config.repos[REPO] = { autonomy: "merge", checks: ["make test"], release: { onMerge: ["true"], onShip: ["true"] } };
  });
  github.add(OWNER, NAME, 8, "Fix crash", ["isobot:ready"]);
  await cycle(pipeline);
  assert.deepEqual(github.merged, [100]);
  assert.ok(repo.calls.includes("checkout merge-100 8-merge"));
  assert.equal(store.get("codybontecou/time.md#8")!.state, "awaiting_ship");
  assert.match(github.commentsFor(OWNER, NAME, 8).at(-1)!, /Add the `isobot:ship` label/);

  await github.addLabels(OWNER, NAME, 8, ["isobot:ship"]);
  await pipeline.followUp();
  assert.equal(store.get("codybontecou/time.md#8")!.state, "shipped");
  assert.ok(!github.get(OWNER, NAME, 8).labels.includes("isobot:ship"));
  assert.match(github.commentsFor(OWNER, NAME, 8).at(-1)!, /Ship step finished/);
});

test("failing checks are fed back to the builder until they pass", async () => {
  const failing: CheckReport = { configured: true, passed: false, results: [{ command: "make test", ok: false, output: "1 failing" }] };
  const { github, pipeline, builder, store, checkCalls } = setup(config => {
    config.repos[REPO] = { autonomy: "merge", checks: ["make test"] };
  }, [failing, failing]);
  github.add(OWNER, NAME, 9, "Fix bug", ["isobot:ready"]);
  await cycle(pipeline);
  assert.equal(builder.reviseFeedback.length, 2);
  assert.match(builder.reviseFeedback[0], /make test` failed:\n\n```\n1 failing/);
  assert.equal(checkCalls.length, 3);
  assert.equal(store.get("codybontecou/time.md#9")!.state, "merged");
});

test("checks that never pass leave the PR to a human", async () => {
  const failing: CheckReport = { configured: true, passed: false, results: [{ command: "make test", ok: false, output: "nope" }] };
  const { github, pipeline, store } = setup(config => {
    config.repos[REPO] = { autonomy: "merge", checks: ["make test"] };
  }, [failing, failing, failing, failing, failing]);
  github.add(OWNER, NAME, 10, "Hard bug", ["isobot:ready"]);
  await cycle(pipeline);
  assert.equal(github.merged.length, 0);
  assert.equal(store.get("codybontecou/time.md#10")!.state, "pr_open");
  assert.match(github.commentsFor(OWNER, NAME, 10).at(-1)!, /runner checks failed/);
});

test("reviewer change requests trigger a revision before the gate", async () => {
  const { github, pipeline, builder } = setup(config => {
    config.repos[REPO] = { autonomy: "merge", checks: ["make test"] };
  });
  builder.reviews = [{ verdict: "request_changes", confidence: 0.4, risk: "medium", summary: "Missing edge case", concerns: ["Empty list crashes"] }];
  github.add(OWNER, NAME, 11, "Feature", ["isobot:ready"]);
  await cycle(pipeline);
  assert.match(builder.reviseFeedback[0], /Empty list crashes/);
  assert.deepEqual(github.merged, [100]);
});

test("no changes from the builder fails the job with its explanation", async () => {
  const { github, pipeline, store, repo, builder } = setup();
  repo.changes = false;
  builder.implementResult = { ok: true, sessionId: "s", summary: "This needs a design decision about X." };
  github.add(OWNER, NAME, 12, "Vague", ["isobot:ready"]);
  await cycle(pipeline);
  assert.equal(store.get("codybontecou/time.md#12")!.state, "failed");
  assert.deepEqual(github.get(OWNER, NAME, 12).labels, ["isobot:failed"]);
  assert.match(github.commentsFor(OWNER, NAME, 12).at(-1)!, /made no changes[\s\S]*design decision about X/);
});

test("the stop label prevents claiming and stops a queued job", async () => {
  const { github, pipeline, store, builder } = setup();
  github.add(OWNER, NAME, 13, "Stop me", ["isobot:ready", "isobot:stop"]);
  await cycle(pipeline);
  assert.equal(store.get("codybontecou/time.md#13"), null);

  github.add(OWNER, NAME, 14, "Stop later", ["isobot:ready"]);
  await pipeline.discover();
  await github.addLabels(OWNER, NAME, 14, ["isobot:stop"]);
  await Promise.all(pipeline.startQueued());
  assert.equal(store.get("codybontecou/time.md#14")!.state, "stopped");
  assert.equal(builder.implementCalls, 0);
});

test("a stop label added during the build blocks an automatic merge", async () => {
  const { github, pipeline, builder } = setup(config => {
    config.repos[REPO] = { autonomy: "merge", checks: ["make test"] };
  });
  github.add(OWNER, NAME, 15, "Change", ["isobot:ready"]);
  const original = builder.implement.bind(builder);
  builder.implement = async () => {
    await github.addLabels(OWNER, NAME, 15, ["isobot:stop"]);
    return original();
  };
  await cycle(pipeline);
  assert.equal(github.merged.length, 0);
  assert.match(github.commentsFor(OWNER, NAME, 15).at(-1)!, /stop label/);
});

test("GitHub CI failure blocks an automatic merge", async () => {
  const { github, pipeline } = setup(config => {
    config.repos[REPO] = { autonomy: "merge", checks: ["make test"] };
  });
  github.ci = "failure";
  github.add(OWNER, NAME, 16, "Change", ["isobot:ready"]);
  await cycle(pipeline);
  assert.equal(github.merged.length, 0);
  assert.match(github.commentsFor(OWNER, NAME, 16).at(-1)!, /GitHub CI is failure/);
});

test("a refused merge (e.g. conflict) leaves the PR for a human instead of failing", async () => {
  const { github, pipeline, store } = setup(config => {
    config.repos[REPO] = { autonomy: "merge", checks: ["make test"] };
  });
  github.merge = async () => { throw new Error("Pull Request is not mergeable"); };
  github.add(OWNER, NAME, 19, "Change", ["isobot:ready"]);
  await cycle(pipeline);
  assert.equal(store.get("codybontecou/time.md#19")!.state, "pr_open");
  assert.deepEqual(github.get(OWNER, NAME, 19).labels, ["isobot:review"]);
  assert.match(github.commentsFor(OWNER, NAME, 19).at(-1)!, /refused the merge \(Pull Request is not mergeable\)/);
});

test("a human merge of a pr_open job triggers the release step", async () => {
  const { github, pipeline, store, repo } = setup(config => {
    config.repos[REPO] = { release: { onMerge: ["true"], onShip: [] } };
  });
  github.add(OWNER, NAME, 17, "Copy tweak", ["isobot:ready"]);
  await cycle(pipeline);
  assert.equal(store.get("codybontecou/time.md#17")!.state, "pr_open");
  await github.merge(OWNER, NAME, 100);
  await pipeline.followUp();
  assert.ok(repo.calls.includes("checkout merge-100 17-merge"));
  assert.equal(store.get("codybontecou/time.md#17")!.state, "released");
  assert.ok(!github.get(OWNER, NAME, 17).labels.includes("isobot:review"));
});

test("recover re-queues interrupted builds and gives up after three attempts", async () => {
  const { github, pipeline, store } = setup();
  github.add(OWNER, NAME, 18, "Flaky", ["isobot:ready"]);
  await pipeline.discover();
  store.update("codybontecou/time.md#18", { state: "building", attempts: 3 });
  pipeline.recover();
  assert.equal(store.get("codybontecou/time.md#18")!.state, "queued");
  await Promise.all(pipeline.startQueued());
  assert.equal(store.get("codybontecou/time.md#18")!.state, "failed");
  assert.match(store.get("codybontecou/time.md#18")!.lastError!, /gave up after 3/);
});

test("unconfigured repositories are never touched", async () => {
  const { github, pipeline } = setup();
  github.add("stranger", "repo", 1, "Hack", ["isobot:ready"]);
  await cycle(pipeline);
  assert.deepEqual(github.get("stranger", "repo", 1).labels, ["isobot:ready"]);
});

test("task text strips markers and the old Codex trigger, and adds repo notes", () => {
  const config = loadConfig();
  const task = buildTask({
    owner: OWNER, repo: NAME, number: 1, title: "T", url: "u", state: "open", labels: [], author: "a",
    body: "Do X\n\n@codex implement this\n<!-- isobot:discord-event:1 -->",
  }, { ...config.defaults, notes: "Use SwiftUI." });
  assert.ok(!task.includes("@codex"));
  assert.ok(!task.includes("isobot:discord-event"));
  assert.match(task, /Do X/);
  assert.match(task, /Use SwiftUI\./);
});

test("branch slugs are short and safe", () => {
  assert.equal(slug("Add CSV export (v2)!"), "add-csv-export-v2");
  assert.equal(slug("!!!"), "change");
  assert.ok(slug("a".repeat(100)).length <= 40);
});
