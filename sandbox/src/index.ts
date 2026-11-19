import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { decide, PLACEHOLDER_TOKEN, type OutboundContext } from "./policy.js";

/**
 * isobot's build sandboxes: one Container per runner job, driven over HTTP by the runner on the Mac.
 * The runner keeps the decisions (what to build, gates, pushes); the Container does the heavy work
 * (clone, Claude Code, npm, site builds). See docs/cloud-builds.md.
 */

export interface Env {
  SANDBOX: DurableObjectNamespace<BuildSandbox>;
  /** The runner's bearer token for this API. */
  SANDBOX_API_TOKEN: string;
  /** Claude Code's token (`claude setup-token`); the Container only ever sees a placeholder. */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** Read access to the repositories the runner builds; added to git fetches of the job's own repo only. */
  GITHUB_TOKEN?: string;
  /** Container size: lite, standard-1 … standard-4. */
  INSTANCE_TYPE?: string;
}

const TASKS = "/isobot/tasks";
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** exec() doesn't inherit start() env; every command that may make HTTPS requests needs these. */
const BASE_ENV: Record<string, string> = {
  HOME: "/root",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
  REQUESTS_CA_BUNDLE: CA_PATH,
  CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_TOKEN,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // Claude Code runs as root here, where skipping its permission prompts needs this. The Container is the sandbox.
  IS_SANDBOX: "1",
  CI: "1",
};
/** Requests keep a Container awake; a running process doesn't. The alarm checks well inside this. */
const INACTIVITY_MS = 30 * 60_000;
const CHECK_MS = 60_000;
/** stdout/stderr returned per poll by default; the files keep everything. */
const DEFAULT_TAIL = 2 * 1024 * 1024;

/** `"$@"` runs in its own process group (setsid), so killing the task kills its children too. */
const TASK_SCRIPT = `dir="$1"; shift
"$@" <"$dir/stdin" >"$dir/stdout" 2>"$dir/stderr"
printf '%s\\n' "$?" >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"`;

export interface TaskRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export type TaskStatus =
  | { state: "running" }
  | { state: "exited"; exitCode: number; stdout: string; stderr: string }
  /** The Container stopped, or the process died without an exit code (killed). */
  | { state: "lost"; stdout: string; stderr: string };

interface SandboxState extends DurableObjectState {
  readonly exports: { Outbound(options: { props: OutboundProps }): Fetcher };
}

interface OutboundProps { repo: string }

export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ctx: OutboundContext = { repo: this.ctx.props.repo, claudeToken: this.env.CLAUDE_CODE_OAUTH_TOKEN, githubToken: this.env.GITHUB_TOKEN };
    const decision = decide(url, ctx);
    if (decision.action === "deny") {
      console.log(JSON.stringify({ event: "outbound_denied", host: url.hostname, path: url.pathname, reason: decision.reason }));
      return new Response(`${decision.reason}\n`, { status: decision.status });
    }
    const headers = new Headers(request.headers);
    for (const name of decision.deleteHeaders) headers.delete(name);
    for (const [name, value] of Object.entries(decision.setHeaders)) headers.set(name, value);
    return fetch(new Request(request, { headers }));
  }
}

export class BuildSandbox extends DurableObject<Env> {
  private container: Container;
  private files: Files;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) throw new Error("the Container binding is missing");
    this.container = container;
    this.files = new Files(container);
    // Each Durable Object instance sets its own timeout; it isn't inherited across restarts of the object.
    if (container.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_MS));
  }

  /** Starts the Container for `repo` (owner/name). Returns whether it was already running (its disk kept). */
  async start(name: string, repo: string): Promise<{ running: boolean }> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must be owner/name");
    const known = this.ctx.storage.kv.get<string>("repo");
    if (this.container.running && known === repo) return { running: true };
    if (this.container.running) await this.container.destroy();
    this.ctx.storage.kv.put("repo", repo);
    this.ctx.storage.kv.delete("tasks");
    this.container.start({
      image: this.container.images.sandbox,
      instance: (this.env.INSTANCE_TYPE ?? "standard-2") as ContainerStartupOptions["instance"],
      enableInternet: false,
      labels: { app: "isobot", sandbox: name },
    });
    // Intercepts last for one Container run, so they're installed on every start.
    const outbound = (this.ctx as SandboxState).exports.Outbound({ props: { repo } });
    await this.container.interceptAllOutboundHttp(outbound);
    await this.container.interceptOutboundHttps("*", outbound);
    await this.container.setInactivityTimeout(INACTIVITY_MS);
    return { running: false };
  }

  status(): { running: boolean; repo: string | null } {
    return { running: this.container.running, repo: this.ctx.storage.kv.get<string>("repo") ?? null };
  }

  async startTask(input: TaskRequest): Promise<{ id: string }> {
    this.requireRunning();
    if (!Array.isArray(input.argv) || input.argv.length === 0 || !input.argv.every(a => typeof a === "string")) throw new Error("argv must be a non-empty list of strings");
    const id = crypto.randomUUID();
    const dir = `${TASKS}/${id}`;
    await this.files.mkdir(dir, { recursive: true });
    await this.files.writeFile(`${dir}/stdin`, input.stdin ?? "");
    const task = await this.container.exec(["setsid", "/bin/sh", "-c", TASK_SCRIPT, "task", dir, ...input.argv], {
      cwd: input.cwd ?? "/workspace",
      env: { ...BASE_ENV, ...(input.env ?? {}) },
      stdout: "ignore",
      stderr: "ignore",
    });
    await this.files.writeFile(`${dir}/pid`, String(task.pid));
    this.setTasks([...this.tasks(), id]);
    await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
    return { id };
  }

  async readTask(id: string, tail = DEFAULT_TAIL): Promise<TaskStatus> {
    checkId(id);
    const dir = `${TASKS}/${id}`;
    if (!this.container.running) return { state: "lost", stdout: "", stderr: "the build Container stopped" };
    const output = async () => ({ stdout: await this.tailOf(`${dir}/stdout`, tail), stderr: await this.tailOf(`${dir}/stderr`, tail) });
    const exit = await this.text(`${dir}/exit`);
    if (exit !== undefined) {
      this.setTasks(this.tasks().filter(t => t !== id));
      return { state: "exited", exitCode: Number.parseInt(exit, 10), ...await output() };
    }
    const pid = await this.text(`${dir}/pid`);
    if (pid === undefined) return { state: "lost", stdout: "", stderr: "no such task" };
    if (await this.alive(pid)) return { state: "running" };
    // It can finish between the two reads: the wrapper writes the exit code before it exits.
    const late = await this.text(`${dir}/exit`);
    this.setTasks(this.tasks().filter(t => t !== id));
    return late !== undefined ? { state: "exited", exitCode: Number.parseInt(late, 10), ...await output() } : { state: "lost", ...await output() };
  }

  /** Kills a task and everything it started. */
  async killTask(id: string): Promise<void> {
    checkId(id);
    if (!this.container.running) return;
    const pid = await this.text(`${TASKS}/${id}/pid`);
    if (pid !== undefined) await this.run(["/bin/sh", "-c", 'kill -TERM -- "-$1" 2>/dev/null; sleep 5; kill -KILL -- "-$1" 2>/dev/null; true', "kill", pid.trim()]);
    this.setTasks(this.tasks().filter(t => t !== id));
  }

  /** Every task still running, for a runner that restarted and must take over its jobs. */
  async runningTasks(): Promise<string[]> {
    const running: string[] = [];
    for (const id of this.tasks()) if ((await this.readTask(id, 0)).state === "running") running.push(id);
    return running;
  }

  async readFile(path: string): Promise<Response | null> {
    this.requireRunning();
    try {
      return await this.files.readFile(path);
    } catch (error) {
      if (SandboxFileError.is(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeFile(path: string, body: ReadableStream<Uint8Array> | ArrayBuffer | string): Promise<void> {
    this.requireRunning();
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await this.files.mkdir(dir, { recursive: true });
    await this.files.writeFile(path, body);
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete("tasks");
    this.ctx.storage.kv.delete("repo");
    if (this.container.running) await this.container.destroy();
  }

  /** Each check is a request to the Container, which keeps it awake while a task runs. */
  async alarm(): Promise<void> {
    if (!this.container.running) return;
    if ((await this.runningTasks()).length) await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
  }

  private requireRunning(): void {
    if (!this.container.running) throw new HttpError(409, "the build Container isn't running; start it first");
  }

  private tasks(): string[] {
    return this.ctx.storage.kv.get<string[]>("tasks") ?? [];
  }

  private setTasks(ids: string[]): void {
    this.ctx.storage.kv.put("tasks", [...new Set(ids)]);
  }

  private async alive(pid: string): Promise<boolean> {
    // kill is a shell builtin; slim images have no kill binary.
    return (await this.run(["/bin/sh", "-c", 'kill -0 "$1"', "probe", pid.trim()])).exitCode === 0;
  }

  private async text(path: string): Promise<string | undefined> {
    try {
      return await (await this.files.readFile(path)).text();
    } catch (error) {
      if (SandboxFileError.is(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async tailOf(path: string, bytes: number): Promise<string> {
    if (bytes <= 0) return "";
    const result = await this.run(["tail", "-c", String(bytes), path]);
    return result.exitCode === 0 ? result.stdout : "";
  }

  private async run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const process = await this.container.exec(argv, { cwd: "/", env: BASE_ENV });
    const output = await process.output();
    const decoder = new TextDecoder();
    return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function checkId(id: string): void {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "bad task id");
}

/** Sandbox names are the runner's job keys: lowercase letters, digits and dashes. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Paths the API may read or write: absolute, no `..`. */
function checkPath(path: string | null): string {
  if (!path || !path.startsWith("/") || path.split("/").includes("..")) throw new HttpError(400, "path must be absolute, without ..");
  return path;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.SANDBOX_API_TOKEN ?? ""}`;
  if (!env.SANDBOX_API_TOKEN || header.length !== expected.length) return false;
  return timingSafeEqual(new TextEncoder().encode(header), new TextEncoder().encode(expected));
}

/**
 * The runner's API (all routes need `Authorization: Bearer $SANDBOX_API_TOKEN`):
 *   POST   /sandboxes/:name/start         {repo}                → {running}  (true: it was up, disk kept)
 *   GET    /sandboxes/:name                                     → {running, repo}
 *   DELETE /sandboxes/:name                                     → destroys the Container
 *   POST   /sandboxes/:name/tasks         {argv, cwd, env, stdin} → {id}
 *   GET    /sandboxes/:name/tasks                               → {running: [id]}
 *   GET    /sandboxes/:name/tasks/:id?tail=bytes                → TaskStatus
 *   DELETE /sandboxes/:name/tasks/:id                           → kills it and its children
 *   GET    /sandboxes/:name/files?path=/abs                     → the file (404 if missing)
 *   PUT    /sandboxes/:name/files?path=/abs  (raw body)         → writes it
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (!authorized(request, env)) return new Response("unauthorized\n", { status: 401 });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "sandboxes" || !parts[1] || !NAME.test(parts[1])) return new Response("not found\n", { status: 404 });
    const name = parts[1];
    const sandbox = env.SANDBOX.getByName(name);
    const route = `${request.method} ${parts.slice(2).join("/").replace(/^tasks\/[^/]+$/, "tasks/:id")}`;
    try {
      switch (route) {
        case "POST start": {
          const body = await request.json<{ repo: string }>();
          return Response.json(await sandbox.start(name, body.repo));
        }
        case "GET ": return Response.json(await sandbox.status());
        case "DELETE ": await sandbox.destroy(); return new Response(null, { status: 204 });
        case "POST tasks": return Response.json(await sandbox.startTask(await request.json<TaskRequest>()));
        case "GET tasks": return Response.json({ running: await sandbox.runningTasks() });
        case "GET tasks/:id": {
          const tail = Number(url.searchParams.get("tail") ?? DEFAULT_TAIL);
          return Response.json(await sandbox.readTask(parts[3], Number.isFinite(tail) ? Math.min(Math.max(tail, 0), 16 * 1024 * 1024) : DEFAULT_TAIL));
        }
        case "DELETE tasks/:id": await sandbox.killTask(parts[3]); return new Response(null, { status: 204 });
        case "GET files": {
          const file = await sandbox.readFile(checkPath(url.searchParams.get("path")));
          return file ? new Response(file.body) : new Response("not found\n", { status: 404 });
        }
        case "PUT files": await sandbox.writeFile(checkPath(url.searchParams.get("path")), await request.arrayBuffer()); return new Response(null, { status: 204 });
        default: return new Response("not found\n", { status: 404 });
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : /isn't running/.test(String(error)) ? 409 : 500;
      console.log(JSON.stringify({ event: "sandbox_error", route, sandbox: name, error: String(error).slice(0, 500) }));
      return new Response(`${(error as Error).message ?? error}\n`, { status });
    }
  },
} satisfies ExportedHandler<Env>;
