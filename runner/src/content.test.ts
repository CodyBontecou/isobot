import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig, type ContentConfig, type RunnerConfig } from "./config.js";
import { ContentTrain, contentEvidenceKey, CONTENT_BUILD_RULES, parseResearch, parseSearchTotals, publishedUrls, researchDue, type ContentDeps } from "./content.js";
import type { AgentJsonInput } from "./builder.js";
import { Notifier } from "./notify.js";
import { Pipeline, type PipelineDeps } from "./pipeline.js";
import type { CheckReport } from "./policy.js";
import { Store } from "./store.js";
import { FakeBuilder, FakeGitHub, FakeRepo, testConfig } from "./testing.js";

const REPO = "codybontecou/time.md";
const [OWNER, NAME] = REPO.split("/");

const SITE: ContentConfig = {
  site: "timemd.app", openseoProjectId: "project-1234", perDay: 3,
  allowedPaths: ["website/**"], checks: ["npm run site:check"], notes: "Posts go in website/blog/<slug>.md.",
};

function setup(content: Partial<ContentConfig> = {}) {
  const config = testConfig();
  // Only the test site: the real config's sites would join every content tick.
  for (const policy of Object.values(config.repos)) delete policy.content;
  config.repos[REPO] = { autonomy: "pr", checks: ["make test"], devices: { ios: { deviceType: "iPhone 17" } }, content: { ...SITE, ...content } };
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  const builder = new FakeBuilder();
  const repo = new FakeRepo();
  repo.diff_ = { files: [{ path: "website/blog/export-csv.md", added: 120, removed: 0, binary: false }], changedLines: 120 };
  const checkCalls: string[][] = [];
  const leases: string[] = [];
  const deps: PipelineDeps = {
    config, env: { home: "/tmp/isobot-test" }, store, github, builder, notifier: new Notifier(), repo: () => repo,
    checks: async (_cwd, commands): Promise<CheckReport> => {
      checkCalls.push(commands);
      return { configured: commands.length > 0, passed: true, results: commands.map(command => ({ command, ok: true, output: "" })) };
    },
    devices: { lease: async (id: string) => { leases.push(id); return { env: {}, describe: () => "", release: async () => {} }; } } as never,
  };
  const pipeline = new Pipeline(deps);
  return { config, store, github, builder, repo, pipeline, checkCalls, leases, deps };
}

test("a content issue builds with the site's checks on the app's devices, and merges where the app itself wouldn't", async () => {
  const { github, pipeline, store, checkCalls, leases, builder } = setup();
  github.add(OWNER, NAME, 5, "Export Time data to CSV", ["isobot:content", "isobot:ready", "isobot:auto"], "Write the guide.");
  store.setCursor(contentEvidenceKey(OWNER, NAME, 5), "120 impressions at position 9");
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());

  const job = store.get("codybontecou/time.md#5")!;
  assert.equal(job.kind, "content");
  assert.equal(job.state, "merged");
  assert.deepEqual(checkCalls[0], ["npm run site:check"]);
  assert.deepEqual(leases, ["codybontecou/time.md#5"]);
  assert.match(builder.reviewTasks[0], /Content standard/);
  assert.match(builder.reviewTasks[0], /Posts go in website\/blog/);
  assert.match(builder.reviewTasks[0], /120 impressions at position 9/);
  assert.ok(builder.reviewTasks[0].includes(CONTENT_BUILD_RULES));
});

test("content that strays outside the site's paths is sent back to take the files out, and merges once it has", async () => {
  const { github, pipeline, store, repo, builder } = setup();
  const clean = repo.diff_;
  repo.diff_ = { files: [{ path: "website/blog/a.md", added: 10, removed: 0, binary: false }, { path: "Sources/App.swift", added: 1, removed: 0, binary: false }], changedLines: 11 };
  const revise = builder.revise.bind(builder);
  builder.revise = async input => { repo.diff_ = clean; return revise(input); };
  github.add(OWNER, NAME, 6, "A post", ["isobot:content", "isobot:ready", "isobot:auto"]);
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  assert.match(builder.reviseFeedback[0], /Outside the site's content paths:\n- Sources\/App\.swift/);
  assert.match(builder.reviseFeedback[0], /- website\/\*\*/);
  assert.equal(builder.reviewTasks.length, 1, "review waits until the paths are clean");
  assert.equal(store.get("codybontecou/time.md#6")!.state, "merged");
});

test("content that still strays after its path rounds is dropped, not left for a human", async () => {
  const { github, pipeline, store, repo, builder } = setup();
  repo.diff_ = { files: [{ path: "website/blog/a.md", added: 10, removed: 0, binary: false }, { path: "Sources/App.swift", added: 1, removed: 0, binary: false }], changedLines: 11 };
  github.add(OWNER, NAME, 6, "A post", ["isobot:content", "isobot:ready", "isobot:auto"]);
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  assert.equal(builder.reviseFeedback.length, 2);
  const job = store.get("codybontecou/time.md#6")!;
  assert.equal(job.state, "closed");
  assert.match(job.lastError!, /^dropped: changes files outside the allowed paths: Sources\/App\.swift/);
  assert.equal(github.get(OWNER, NAME, 6).state, "closed");
  assert.equal(github.closedAs.get("codybontecou/time.md#6"), "not_planned");
  assert.ok(!github.get(OWNER, NAME, 6).labels.includes("isobot:review"));
  assert.ok(!github.get(OWNER, NAME, 6).labels.includes("isobot:ready"));
  assert.equal((await github.pull(OWNER, NAME, job.prNumber!)).state, "closed");
  assert.match(github.commentsFor(OWNER, NAME, 6).at(-1)!, /dropped this piece[\s\S]*nothing waits on you/);
});

test("content is reviewed as content and merges at the content bar, below the repo's", async () => {
  const { github, pipeline, store, builder } = setup();
  builder.reviews.push({ verdict: "approve", confidence: 0.8, risk: "low", summary: "Good guide.", concerns: [] });
  github.add(OWNER, NAME, 8, "A post", ["isobot:content", "isobot:ready", "isobot:auto"]);
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  assert.deepEqual(builder.reviewContent, [true]);
  assert.equal(store.get("codybontecou/time.md#8")!.state, "merged");
  assert.match(builder.reviewTasks[0], /## Files this content may change[\s\S]*- `website\/\*\*`/);
});

test("ordinary issues are reviewed as code", async () => {
  const { github, pipeline, builder } = setup();
  github.add(OWNER, NAME, 7, "Fix export", ["isobot:ready"]);
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  assert.deepEqual(builder.reviewContent, [false]);
});

test("content whose remaining doubts only a person could settle is dropped with them", async () => {
  const { github, pipeline, store, builder } = setup();
  builder.reviews.push({ verdict: "approve", confidence: 0.6, risk: "low", summary: "Unclear.", concerns: [], blockers: ["A new medical claim needs the owner"] });
  github.add(OWNER, NAME, 9, "A post", ["isobot:content", "isobot:ready", "isobot:auto"]);
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  const job = store.get("codybontecou/time.md#9")!;
  assert.equal(job.state, "closed");
  assert.match(job.lastError!, /confidence 0\.60 is below 0\.75/);
  assert.match(github.commentsFor(OWNER, NAME, 9).at(-1)!, /A new medical claim needs the owner/);
});

test("content on a site set to pr autonomy still waits for its owner", async () => {
  const { github, pipeline, store } = setup({ autonomy: "pr" });
  github.add(OWNER, NAME, 10, "A post", ["isobot:content", "isobot:ready", "isobot:auto"]);
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  assert.equal(store.get("codybontecou/time.md#10")!.state, "pr_open");
  assert.equal(github.get(OWNER, NAME, 10).state, "open");
});

test("research hears why earlier pieces were dropped", async () => {
  const { config, store, github } = setup();
  store.enqueue(OWNER, NAME, 3, "Old guide", "content");
  store.update("codybontecou/time.md#3", { state: "closed", lastError: "dropped: reviewer confidence 0.60 is below 0.75" });
  const t = train(config, store, github);
  t.outputs.push({ action: "skip", kind: "post", title: "", brief: "", targetQueries: [], targetUrl: "", privateEvidence: "", reason: "nothing", creditsStart: null, creditsEnd: null });
  await t.content.tick();
  assert.match(t.agentCalls[0].prompt, /#3 \[dropped: reviewer confidence 0\.60 is below 0\.75\] Old guide/);
});

test("ordinary issues in a repo with a site keep the app's policy", async () => {
  const { github, pipeline, store, checkCalls, leases } = setup();
  github.add(OWNER, NAME, 7, "Fix export", ["isobot:ready"]);
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  assert.equal(store.get("codybontecou/time.md#7")!.kind, "issue");
  assert.deepEqual(checkCalls[0], ["make test"]);
  assert.equal(leases.length, 1);
  assert.equal(store.get("codybontecou/time.md#7")!.state, "pr_open");
});

test("content builds take at most content.maxConcurrentJobs slots", async () => {
  const { github, pipeline, store } = setup();
  for (const n of [1, 2, 3]) github.add(OWNER, NAME, n, `Post ${n}`, ["isobot:content", "isobot:ready", "isobot:auto"]);
  github.add(OWNER, NAME, 4, "App fix", ["isobot:ready"]);
  await pipeline.discover();
  const started = pipeline.startQueued();
  assert.deepEqual(pipeline.activeJobs.sort(), ["codybontecou/time.md#1", "codybontecou/time.md#4"]);
  await Promise.all(started);
  assert.equal(store.get("codybontecou/time.md#2")!.state, "queued");
});

test("research is spread across the day's hours and holds back when the backlog grows", () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 18, h, m);
  const base = { perDay: 3, hours: [6, 22] as [number, number], backlog: 0 };
  assert.equal(researchDue({ ...base, now: at(5), doneToday: 0, last: null }), false);
  assert.equal(researchDue({ ...base, now: at(6), doneToday: 0, last: null }), true);
  assert.equal(researchDue({ ...base, now: at(10), doneToday: 1, last: at(6).toISOString() }), false);
  assert.equal(researchDue({ ...base, now: at(11, 20), doneToday: 1, last: at(6).toISOString() }), true);
  assert.equal(researchDue({ ...base, now: at(21), doneToday: 3, last: at(6).toISOString() }), false);
  assert.equal(researchDue({ ...base, now: at(12), doneToday: 1, last: at(6).toISOString(), backlog: 3 }), false);
});

test("published URLs are read from the builder's summary and kept to the site", () => {
  const summary = "Wrote it.\n\nPublished URLs: https://timemd.app/blog/csv/, <https://www.timemd.app/guides/x/>, https://evil.example/x, http://timemd.app/insecure";
  assert.deepEqual(publishedUrls(summary, "timemd.app"), ["https://timemd.app/blog/csv/", "https://www.timemd.app/guides/x/"]);
  assert.deepEqual(publishedUrls("no line here https://timemd.app/a", "timemd.app"), []);
});

test("research output without a title or brief is a skip, and odd values are tamed", () => {
  assert.equal(parseResearch({ action: "propose", title: "", brief: "x" }).action, "skip");
  const r = parseResearch({ action: "propose", kind: "essay", title: "  A   title ", brief: "Brief", targetQueries: ["q"], creditsStart: 100, creditsEnd: -1 });
  assert.equal(r.action, "propose");
  assert.equal(r.kind, "post");
  assert.equal(r.title, "A title");
  assert.equal(r.creditsEnd, null);
});

function train(config: RunnerConfig, store: Store, github: FakeGitHub, overrides: Partial<ContentDeps> = {}) {
  const agentCalls: AgentJsonInput[] = [];
  const said: string[] = [];
  const posted: string[] = [];
  const runs: string[] = [];
  const outputs: unknown[] = [];
  const content = new ContentTrain({
    config, store, github, repo: () => new FakeRepo(),
    notifier: { discord: async (text: string) => { posted.push(text); }, say: async (_job: unknown, text: string) => { said.push(text); } } as never,
    agent: async input => { agentCalls.push(input); return { output: outputs.shift() }; },
    pullBody: async () => "Summary\n\nPublished URLs: https://timemd.app/blog/csv/",
    run: async (_cwd, command) => { runs.push(command); return { ok: true, output: "" }; },
    status: async () => 200,
    now: () => new Date(2026, 10, 18, 9),
    ...overrides,
  });
  return { content, agentCalls, said, posted, runs, outputs };
}

test("research files a public brief with the content, ready and auto labels, and keeps evidence private", async () => {
  const { config, store, github } = setup();
  const t = train(config, store, github);
  t.outputs.push({
    action: "propose", kind: "guide", title: "Export Time data to CSV", brief: "## Brief\nOutline…", targetQueries: ["time csv export"],
    targetUrl: "https://timemd.app/blog/csv/", privateEvidence: "GSC: 120 impressions", reason: "", creditsStart: 1000, creditsEnd: 940,
  });
  await t.content.tick();
  const issue = github.get(OWNER, NAME, 1);
  assert.deepEqual(issue.labels, ["isobot:content", "isobot:ready", "isobot:auto"]);
  assert.match(issue.body, /\*\*Kind:\*\* guide/);
  assert.doesNotMatch(issue.body, /120 impressions/);
  assert.equal(store.cursor(contentEvidenceKey(OWNER, NAME, 1)), "GSC: 120 impressions");
  assert.equal(store.cursor("content:credits:2026-11-18"), "60");
  assert.ok(t.agentCalls[0].allowedTools.includes("mcp__plugin_openseo_openseo__get_search_console_performance"));
  assert.ok(!t.agentCalls[0].allowedTools.some(tool => /update_project_context|delete_|submit_indexnow/.test(tool)));
  // Not due again until the next slot.
  await t.content.tick();
  assert.equal(t.agentCalls.length, 1);
});

test("a failed research run gives its slot back, and a usage-limit pause holds research", async () => {
  const { config, store, github } = setup();
  const t = train(config, store, github, { agent: async () => { throw new Error("overloaded"); } });
  await t.content.tick();
  assert.equal(store.cursor(`content:${REPO}:day:2026-11-18`.toLowerCase()), "0");
  const paused = setup();
  paused.store.pauseBuilds(Date.now() + 3_600_000, "usage limit");
  const p = train(paused.config, paused.store, paused.github);
  await p.content.tick();
  assert.equal(p.agentCalls.length, 0);
});

test("research stops below the credit floor and says so once a day", async () => {
  const { config, store, github } = setup();
  store.setCursor("content:credits:balance", "120");
  const t = train(config, store, github);
  await t.content.tick();
  store.setCursor(`content:${REPO}:last`.toLowerCase(), "");
  await t.content.tick();
  assert.equal(t.agentCalls.length, 0);
  assert.equal(t.posted.filter(p => /Content research paused: OpenSEO balance 120/.test(p)).length, 1);
});

test("merged content is recorded once its pages are live, with the site's IndexNow script", async () => {
  const { config, store, github } = setup({ indexNow: "npm run seo:indexnow --" });
  store.setCursor(`content:${REPO}:last`.toLowerCase(), new Date(2026, 10, 18, 9).toISOString());
  github.add(OWNER, NAME, 9, "CSV guide", ["isobot:content"], "Brief\n\n---\n**Kind:** guide\n**Queries:** `time csv`");
  store.enqueue(OWNER, NAME, 9, "CSV guide", "content");
  store.update("codybontecou/time.md#9", { state: "merged", prNumber: 100 });
  let live = 404;
  const t = train(config, store, github, { status: async () => live, now: () => new Date() });
  t.outputs.push({ indexNow: "skipped", logged: true, note: "" });
  await t.content.publish({ owner: OWNER, repo: NAME, content: config.repos[REPO].content! });
  assert.equal(t.agentCalls.length, 0);
  live = 200;
  await t.content.publish({ owner: OWNER, repo: NAME, content: config.repos[REPO].content! });
  assert.deepEqual(t.runs, ["npm run seo:indexnow -- 'https://timemd.app/blog/csv/'"]);
  assert.deepEqual(t.agentCalls[0].allowedTools, ["mcp__plugin_openseo_openseo__update_project_context"]);
  assert.match(t.agentCalls[0].prompt, /Kind: guide/);
  assert.match(t.said.at(-1)!, /Live: https:\/\/timemd\.app\/blog\/csv\//);
  await t.content.publish({ owner: OWNER, repo: NAME, content: config.repos[REPO].content! });
  assert.equal(t.agentCalls.length, 1);
});

test("publishing waits until a production deploy contains the merge, then reports one that never does", async () => {
  const { config, store, github } = setup({ deploy: { workflow: "website-publish.yml" } });
  const site = { owner: OWNER, repo: NAME, content: config.repos[REPO].content! };
  github.add(OWNER, NAME, 9, "CSV guide refresh", ["isobot:content"], "Brief\n\n---\n**Kind:** refresh");
  await github.createPull(OWNER, NAME, { head: "isobot/9-csv", base: "main", title: "x", body: "" });
  await github.merge(OWNER, NAME, 100);
  store.enqueue(OWNER, NAME, 9, "CSV guide refresh", "content");
  store.update("codybontecou/time.md#9", { state: "merged", prNumber: 100 });
  let clock = new Date();
  // The refreshed page answers 200 all along: only the deploy says whether the new text is out.
  const t = train(config, store, github, { now: () => clock });
  t.outputs.push({ indexNow: "submitted", logged: true, note: "" });
  github.deploys.set(`${OWNER}/${NAME}`, "older");
  await t.content.publish(site);
  assert.equal(t.agentCalls.length, 0);
  github.deploys.set(`${OWNER}/${NAME}`, "later");
  github.descendants.set("merge-100", ["later"]);
  await t.content.publish(site);
  assert.equal(t.agentCalls.length, 1, "a later deploy that contains the merge counts");

  const other = setup({ deploy: { environment: "Production" } });
  other.github.add(OWNER, NAME, 9, "Post", ["isobot:content"]);
  await other.github.createPull(OWNER, NAME, { head: "b", base: "main", title: "x", body: "" });
  await other.github.merge(OWNER, NAME, 100);
  other.store.enqueue(OWNER, NAME, 9, "Post", "content");
  other.store.update("codybontecou/time.md#9", { state: "merged", prNumber: 100 });
  clock = new Date(Date.now() + 4 * 3_600_000);
  const u = train(other.config, other.store, other.github, { now: () => clock });
  await u.content.publish({ owner: OWNER, repo: NAME, content: other.config.repos[REPO].content! });
  assert.equal(u.agentCalls.length, 0);
  assert.match(u.said.at(-1)!, /no successful production deploy was found \(the Production environment\)/);
});

test("content configuration is validated", () => {
  const config = testConfig();
  config.repos[REPO] = { content: { ...SITE, checks: [] } };
  assert.throws(() => validateConfig(config), /content\.checks must build the site/);
  config.repos[REPO] = { content: { ...SITE, perDay: 20 } };
  assert.throws(() => validateConfig(config), /content\.perDay must be 1-12/);
  config.repos[REPO] = { content: { ...SITE, allowedPaths: [] } };
  assert.throws(() => validateConfig(config), /content\.allowedPaths/);
  config.repos[REPO] = { content: { ...SITE, minReviewConfidence: 1.5 } };
  assert.throws(() => validateConfig(config), /content\.minReviewConfidence must be in \(0, 1\]/);
  config.repos[REPO] = { content: { ...SITE, deploy: { workflow: "a.yml", environment: "Production" } as never } };
  assert.throws(() => validateConfig(config), /content\.deploy must be/);
  config.repos[REPO] = { content: SITE };
  config.content = { hours: [22, 6] };
  assert.throws(() => validateConfig(config), /content\.hours/);
});

test("content with executor cloudflare builds and checks in the cloud sandbox, without the app's devices", async () => {
  const cloudBuilder = new FakeBuilder();
  const cloudRepo = new FakeRepo();
  cloudRepo.diff_ = { files: [{ path: "website/blog/export-csv.md", added: 120, removed: 0, binary: false }], changedLines: 120 };
  const cloudChecks: string[][] = [];
  const t = setup({ executor: "cloudflare" });
  const pipeline = new Pipeline({
    ...t.deps,
    cloud: {
      repo: () => cloudRepo, builder: cloudBuilder,
      checks: async (_cwd, commands) => { cloudChecks.push(commands); return { configured: true, passed: true, results: commands.map(command => ({ command, ok: true, output: "" })) }; },
    },
  });
  t.github.add(OWNER, NAME, 20, "A cloud post", ["isobot:content", "isobot:ready", "isobot:auto"], "Write the guide.");
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  assert.equal(t.store.get(`${REPO}#20`)!.state, "merged");
  assert.deepEqual(cloudChecks, [["npm run site:check"]]);
  assert.deepEqual(t.checkCalls, [], "nothing ran on this Mac");
  assert.deepEqual(t.leases, [], "no simulator or emulator for a cloud build");
  assert.equal(cloudBuilder.implementCalls, 1);
  assert.equal(t.builder.implementCalls, 0);
  assert.ok(cloudRepo.calls.includes("push sha1 isobot/20-a-cloud-post"), "the runner pushes the commit that came back");
  // App issues in the same repo still build here.
  t.github.add(OWNER, NAME, 21, "Fix export", ["isobot:ready"]);
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  assert.deepEqual(t.checkCalls, [["make test"]]);
});

test("a cloud content job without a configured sandbox fails with what to set", async () => {
  const t = setup({ executor: "cloudflare" });
  t.github.add(OWNER, NAME, 22, "A cloud post", ["isobot:content", "isobot:ready", "isobot:auto"]);
  await t.pipeline.discover();
  await Promise.all(t.pipeline.startQueued());
  assert.equal(t.store.get(`${REPO}#22`)!.state, "failed");
  assert.match(t.github.commentsFor(OWNER, NAME, 22).at(-1)!, /ISOBOT_SANDBOX_URL and ISOBOT_SANDBOX_TOKEN/);
});

test("executor must be local or cloudflare", () => {
  const config = testConfig();
  config.repos[REPO] = { ...config.repos[REPO], content: { ...SITE, executor: "aws" as never } };
  assert.throws(() => validateConfig(config), /content: executor must be "local" or "cloudflare"/);
});

test("content builds get builder.contentTimeoutMinutes; issue builds keep builder.timeoutMinutes", async () => {
  const { github, pipeline, builder, config } = setup();
  config.builder.contentTimeoutMinutes = 120;
  github.add(OWNER, NAME, 5, "Export Time data to CSV", ["isobot:content", "isobot:ready", "isobot:auto"], "Write the guide.");
  github.add(OWNER, NAME, 6, "Add CSV export", ["isobot:ready"]);
  await pipeline.discover();
  await Promise.all(pipeline.startQueued());
  assert.equal(builder.implementCalls, 2);
  assert.deepEqual([...builder.timeouts].sort(), [120, undefined]);
});

test("builder.contentTimeoutMinutes is validated", () => {
  const config = testConfig();
  config.builder.contentTimeoutMinutes = 0;
  assert.throws(() => validateConfig(config), /builder\.contentTimeoutMinutes must be 1-240/);
  config.builder.contentTimeoutMinutes = 120;
  assert.doesNotThrow(() => validateConfig(config));
});

test("the weekly report keeps Search Console totals for the board, and skips ones it didn't get", async () => {
  const { config, store, github } = setup();
  const t = train(config, store, github);
  const site = { owner: OWNER, repo: NAME, content: config.repos[REPO].content! };
  t.outputs.push({ digest: "Clicks up.", last7: { clicks: 40, impressions: 2000, ctr: 2, position: 18.5 }, previous7: null });
  assert.equal(await t.content.report(site, true), "Clicks up.");
  assert.deepEqual(JSON.parse(store.cursor("content:codybontecou/time.md:search:2026-11-18")!),
    { last7: { clicks: 40, impressions: 2000, ctr: 0.02, position: 18.5 }, previous7: null });
  assert.match(t.posted[0], /weekly search report/);
  store.deleteCursor("content:codybontecou/time.md:search:2026-11-18");
  t.outputs.push({ digest: "Search Console wasn't reachable.", last7: null, previous7: null });
  await t.content.report(site, true);
  assert.equal(store.cursor("content:codybontecou/time.md:search:2026-11-18"), null);
  assert.equal(parseSearchTotals({ clicks: -1, impressions: 1, ctr: 0, position: 1 }), null);
});
