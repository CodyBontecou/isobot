import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ClaudeCodeBuilder } from "./builder.js";
import { CloudRepo, HttpSandboxApi, remoteChecks, remoteExec, runRemote, sandboxFor, sandboxName, type SandboxApi, type TaskRequest, type TaskStatus } from "./cloud.js";
import { isTransient, TransientError } from "./errors.js";
import { Repo } from "./git.js";
import { testConfig } from "./testing.js";

const instant = async () => {};
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };

/**
 * A sandbox that runs its commands on this machine: /workspace and /isobot live under a temp folder.
 * Paths in argv are mapped the same way, so CloudRepo's real git commands and bundles run for real.
 */
class LocalSandbox implements SandboxApi {
  readonly root = mkdtempSync(path.join(tmpdir(), "isobot-sandbox-"));
  running = new Map<string, string>();
  tasks = new Map<string, TaskStatus>();
  argvs: string[][] = [];
  stuck = new Set<string>();
  /** stderr for the next `git clone` calls to fail with, one per call. */
  cloneFailures: string[] = [];
  private n = 0;

  map(p: string): string { return p.startsWith("/workspace/") || p.startsWith("/isobot/") ? path.join(this.root, p) : p; }
  async start(name: string, repo: string) {
    const was = this.running.get(name) === repo;
    this.running.set(name, repo);
    return { running: was };
  }
  async status(name: string) { return { running: this.running.has(name), repo: this.running.get(name) ?? null }; }
  async destroy(name: string) { this.running.delete(name); rmSync(path.join(this.root, "workspace", name), { recursive: true, force: true }); }
  async startTask(name: string, task: TaskRequest) {
    assert.ok(this.running.has(name), "tasks run only in a started sandbox");
    const id = `00000000-0000-0000-0000-${String(++this.n).padStart(12, "0")}`;
    this.argvs.push(task.argv);
    if (this.stuck.has(task.argv[0])) { this.tasks.set(id, { state: "running" }); return { id }; }
    if (task.argv[0] === "git" && task.argv.includes("clone") && this.cloneFailures.length) {
      this.tasks.set(id, { state: "exited", exitCode: 128, stdout: "", stderr: this.cloneFailures.shift()! });
      return { id };
    }
    const cwd = this.map(task.cwd ?? "/workspace");
    mkdirSync(cwd, { recursive: true });
    const [cmd, ...args] = task.argv.map(a => this.map(a));
    const result = spawnSync(cmd, args, { cwd, input: task.stdin, env: { ...process.env, ...GIT_ENV, ...(task.env ?? {}) }, encoding: "utf8" });
    this.tasks.set(id, { state: "exited", exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
    return { id };
  }
  async readTask(_name: string, id: string) { return this.tasks.get(id) ?? { state: "lost" as const, stdout: "", stderr: "" }; }
  async killTask(_name: string, id: string) { this.tasks.set(id, { state: "lost", stdout: "", stderr: "killed" }); }
  async runningTasks() { return [...this.tasks].filter(([, t]) => t.state === "running").map(([id]) => id); }
  async readFile(_name: string, file: string) { const p = this.map(file); return existsSync(p) ? readFileSync(p) : null; }
  async writeFile(_name: string, file: string, data: Buffer | string) { const p = this.map(file); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); }
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A "GitHub" (bare repository with one commit on main), the runner's Repo, and a sandbox. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "isobot-cloud-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", origin, "main");
  const local = new Repo(path.join(root, "home"), "codybontecou", "site", "token", origin);
  const sandbox = new LocalSandbox();
  return { root, origin, local, sandbox, cloud: new CloudRepo(local, sandbox, instant) };
}

test("a cloud workspace's commits come back to the runner's clone as bundles, and only from where it started", async () => {
  const { local, sandbox, cloud } = fixture();
  const main = await cloud.sync("main");
  const branch = "isobot/7-new-post";
  const dir = await cloud.createWorkspace(branch, main);
  assert.equal(dir, `/workspace/${sandboxName("codybontecou", "site", branch)}`);
  assert.equal(sandboxFor(dir), sandboxName("codybontecou", "site", branch));

  // The builder writes and commits one file, and leaves another uncommitted.
  const real = sandbox.map(dir);
  writeFileSync(path.join(real, "post.md"), "# New post\n");
  git(real, "add", "post.md");
  git(real, "commit", "--quiet", "-m", "Add post");
  writeFileSync(path.join(real, "draft.md"), "wip\n");
  await cloud.commitPending(dir, "WIP: interrupted");
  const sha = await cloud.capture(dir, branch);
  assert.equal(sha, git(real, "rev-parse", "HEAD"));
  assert.equal(await cloud.ahead(main, sha), 2);
  const diff = await cloud.diff(main, sha);
  assert.match(diff, /\+# New post/);
  assert.match(diff, /\+wip/);
  assert.equal(git(local.barePath, "rev-parse", `refs/isobot/${branch}`), sha, "the commit is in the runner's own clone");

  // Nothing new since: no bundle needed.
  assert.equal(await cloud.capture(dir, branch), sha);
  assert.equal(await cloud.hasWorkspace(branch), true);
  await cloud.removeWorkspace(branch);
  assert.equal(await cloud.hasWorkspace(branch), false);
});

test("a commit GitHub doesn't have (kept after a restart) is sent to a fresh sandbox as a bundle", async () => {
  const { sandbox, cloud } = fixture();
  const main = await cloud.sync("main");
  const branch = "isobot/8-guide";
  const first = await cloud.createWorkspace(branch, main);
  writeFileSync(path.join(sandbox.map(first), "guide.md"), "step 1\n");
  await cloud.commitPending(first, "WIP: interrupted by a runner restart");
  const wip = await cloud.capture(first, branch);
  // The Container went away; the runner resumes from its saved commit.
  await sandbox.destroy(sandboxName("codybontecou", "site", branch));

  const again = await cloud.createWorkspace(branch, wip);
  assert.equal(git(sandbox.map(again), "rev-parse", "HEAD"), wip);
  assert.ok(sandbox.argvs.some(a => a.includes("/isobot/in.bundle")), "sent as a bundle");
  writeFileSync(path.join(sandbox.map(again), "guide.md"), "step 1\nstep 2\n");
  await cloud.commitPending(again, "Finish");
  const done = await cloud.capture(again, branch);
  assert.equal(await cloud.ahead(main, done), 2);
});

test("a sandbox that's still up at the right commit is kept with its dependencies; at another commit it starts clean", async () => {
  const { sandbox, cloud } = fixture();
  const main = await cloud.sync("main");
  const branch = "isobot/9-tool";
  const dir = await cloud.createWorkspace(branch, main);
  writeFileSync(path.join(sandbox.map(dir), "node_modules.marker"), "");
  await cloud.createWorkspace(branch, main);
  assert.ok(existsSync(path.join(sandbox.map(dir), "node_modules.marker")), "kept");
  writeFileSync(path.join(sandbox.map(dir), "x.md"), "x");
  await cloud.commitPending(dir, "x");
  await cloud.createWorkspace(branch, main);
  assert.ok(!existsSync(path.join(sandbox.map(dir), "node_modules.marker")), "recreated when HEAD moved");
});

const THROTTLED = "fatal: unable to access 'https://github.com/codybontecou/site.git/': The requested URL returned error: 429";

test("a clone GitHub throttles is retried in place after a wait", async () => {
  const { local, sandbox } = fixture();
  const waits: number[] = [];
  const cloud = new CloudRepo(local, sandbox, async ms => { waits.push(ms); });
  const main = await cloud.sync("main");
  sandbox.cloneFailures.push(THROTTLED, THROTTLED);
  const dir = await cloud.createWorkspace("isobot/12-x", main);
  assert.equal(readFileSync(path.join(sandbox.map(dir), "README.md"), "utf8"), "hello\n");
  assert.deepEqual(waits.filter(ms => ms >= 30_000), [30_000, 120_000]);
});

test("a clone still throttled after the retries fails as transient, so the job is requeued rather than failed", async () => {
  const { sandbox, cloud } = fixture();
  const main = await cloud.sync("main");
  sandbox.cloneFailures.push(THROTTLED, THROTTLED, THROTTLED);
  await assert.rejects(cloud.createWorkspace("isobot/13-x", main), (error: Error) => isTransient(error) && /429/.test(error.message));
});

test("a clone that fails for good (not found) isn't retried", async () => {
  const { local, sandbox } = fixture();
  const waits: number[] = [];
  const cloud = new CloudRepo(local, sandbox, async ms => { waits.push(ms); });
  const main = await cloud.sync("main");
  sandbox.cloneFailures.push("remote: Repository not found.\nfatal: repository 'https://github.com/codybontecou/site.git/' not found");
  await assert.rejects(cloud.createWorkspace("isobot/14-x", main), (error: Error) => !isTransient(error));
  assert.deepEqual(waits.filter(ms => ms >= 30_000), []);
});

test("interrupt stops what a restart left running in the sandbox", async () => {
  const { sandbox, cloud } = fixture();
  const main = await cloud.sync("main");
  await cloud.createWorkspace("isobot/10-x", main);
  sandbox.stuck.add("claude");
  await sandbox.startTask(sandboxName("codybontecou", "site", "isobot/10-x"), { argv: ["claude", "-p"] });
  assert.equal((await sandbox.runningTasks()).length, 1);
  await cloud.interrupt("isobot/10-x");
  assert.equal((await sandbox.runningTasks()).length, 0);
});

test("checks run in the job's sandbox, stop at the first failure and report like local checks", async () => {
  const { sandbox, cloud } = fixture();
  const dir = await cloud.createWorkspace("isobot/11-x", await cloud.sync("main"));
  const report = await remoteChecks(sandbox, dir, ["test -f README.md", "echo broken >&2; exit 3", "echo never"], { sleep: instant });
  assert.equal(report.passed, false);
  assert.deepEqual(report.results.map(r => [r.command, r.ok]), [["test -f README.md", true], ["echo broken >&2; exit 3", false]]);
  assert.match(report.results[1].output, /broken/);
});

test("Claude Code runs in the sandbox with the prompt on stdin and never the runner's environment", async () => {
  const sandbox = new LocalSandbox();
  sandbox.running.set("job-1", "codybontecou/site");
  const calls: TaskRequest[] = [];
  const api: SandboxApi = Object.assign(Object.create(sandbox), {
    startTask: async (name: string, task: TaskRequest) => { calls.push(task); return sandbox.startTask(name, { ...task, argv: ["/bin/sh", "-c", 'cat >/dev/null; echo \'{"type":"result","subtype":"success","result":"done","session_id":"s-1"}\''] }); },
  });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "real-secret";
  const builder = new ClaudeCodeBuilder(testConfig().builder, { secrets: [], noWrite: [] }, "claude", undefined, undefined, {
    exec: remoteExec(api, instant), settings: { permissions: { deny: ["Skill(x)"] } },
  });
  const run = await builder.implement({ cwd: "/workspace/job-1", task: "Write the post", sessionId: "11111111-1111-1111-1111-111111111111" });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  assert.deepEqual(run, { ok: true, sessionId: "s-1", summary: "done", turns: undefined });
  assert.equal(calls[0].argv[0], "claude");
  assert.equal(calls[0].stdin, "Write the post");
  assert.equal(calls[0].cwd, "/workspace/job-1");
  assert.deepEqual(calls[0].env, {}, "no runner environment crosses over");
  assert.ok(!JSON.stringify(calls).includes("real-secret"));
  assert.equal(calls[0].argv[calls[0].argv.indexOf("--settings") + 1], JSON.stringify({ permissions: { deny: ["Skill(x)"] } }));
});

test("runRemote kills a command that runs past its timeout, rides out network blips, and calls a lost Container temporary", async () => {
  let reads = 0;
  const killed: string[] = [];
  const stub = (status: () => TaskStatus): SandboxApi => ({
    start: async () => ({ running: true }), status: async () => ({ running: true, repo: null }), destroy: async () => {},
    startTask: async () => ({ id: "t" }), readTask: async () => status(), killTask: async (_n, id) => { killed.push(id); },
    runningTasks: async () => [], readFile: async () => null, writeFile: async () => {},
  });
  let now = 0;
  const clock = async () => { now += 10_000; };
  const realNow = Date.now;
  Date.now = () => realNow() + now;
  try {
    const slow = await runRemote(stub(() => ({ state: "running" })), "s", ["sleep"], { cwd: "/workspace/s", timeoutMs: 30_000, sleep: clock });
    assert.equal(slow.timedOut, true);
    assert.deepEqual(killed, ["t"]);
  } finally {
    Date.now = realNow;
  }
  const flaky = await runRemote(stub(() => {
    if (++reads < 3) throw new TransientError("blip");
    return { state: "exited", exitCode: 0, stdout: "ok", stderr: "" };
  }), "s", ["true"], { cwd: "/", sleep: instant });
  assert.deepEqual(flaky, { code: 0, stdout: "ok", stderr: "", timedOut: false });
  await assert.rejects(runRemote(stub(() => ({ state: "lost", stdout: "", stderr: "the build Container stopped" })), "s", ["npm"], { cwd: "/", sleep: instant }), TransientError);
});

test("the HTTP client sends the bearer token, needs HTTPS, and treats Cloudflare 5xx as temporary", async () => {
  assert.throws(() => new HttpSandboxApi("http://sandbox.example", "t"), /HTTPS/);
  const seen: { url: string; auth: string | null }[] = [];
  let status = 200;
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get("authorization") });
    return new Response(status === 200 ? JSON.stringify({ running: false }) : "boom", { status });
  }) as typeof fetch;
  const api = new HttpSandboxApi("https://sandbox.example/", "secret", fetcher);
  assert.deepEqual(await api.start("job-1", "o/r"), { running: false });
  assert.deepEqual(seen[0], { url: "https://sandbox.example/sandboxes/job-1/start", auth: "Bearer secret" });
  status = 503;
  await assert.rejects(api.status("job-1"), TransientError);
  status = 409;
  await assert.rejects(api.status("job-1"), (error: Error) => !(error instanceof TransientError) && /409/.test(error.message));
  status = 404;
  assert.equal(await api.readFile("job-1", "/isobot/missing"), null);
});
