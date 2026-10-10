import {
  canUseSupportTool,
  supportRole,
  SUPPORT_ROLE_TTL_MS,
  type SupportRole,
} from "./support-permissions.js";
import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./index.js";
import {
  SupportStore,
  SupportError,
  record,
  text,
  identifier,
  type Conversation,
  type SupportJob,
} from "./support-store.js";
import { readJson } from "./http-body.js";

/** Repository scope is deployment-controlled, never supplied by a customer or model. */
export function supportRepository(
  env: Pick<Bindings, "SUPPORT_GITHUB_REPOSITORY">,
) {
  const repository = env.SUPPORT_GITHUB_REPOSITORY;
  if (
    !repository ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repository)
  )
    throw new SupportError(
      503,
      "Support GitHub repository is not configured correctly",
    );
  return repository;
}

const encoder = new TextEncoder();
export async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function turnName(account: string, c: Conversation, job: SupportJob) {
  return `${account}:${c.id}:${job.generation}:${job.id}`;
}
function snapshot(c: Conversation, before?: number) {
  const messages = c.messages
    .filter((m) => before === undefined || m.sequence < before)
    .slice(-50);
  return {
    ...c,
    messages,
    hasMore:
      messages.length > 0 &&
      c.messages.some((m) => m.sequence < messages[0].sequence),
    before: messages[0]?.sequence ?? null,
  };
}
async function key(secret: string | undefined) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret))
    throw new SupportError(503, "Support encryption is not configured");
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.match(/../g)!, (v) => parseInt(v, 16)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
async function encrypt(secret: string | undefined, plain: string, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      await key(secret),
      encoder.encode(plain),
    ),
  );
  return JSON.stringify({ iv: [...iv], bytes: [...bytes] });
}
async function decrypt(
  secret: string | undefined,
  cipher: string,
  aad: string,
) {
  const value = JSON.parse(cipher) as { iv: number[]; bytes: number[] };
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(value.iv),
        additionalData: encoder.encode(aad),
      },
      await key(secret),
      new Uint8Array(value.bytes),
    ),
  );
}

/** Per verified myself.md account; conversations and their Pi turns remain independent. */
export class SupportAccount extends DurableObject<Bindings> {
  private store: SupportStore;
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.store = new SupportStore(ctx.storage.sql);
  }
  async handle(
    account: string,
    action: string,
    input: Record<string, unknown>,
    agent: string | null,
  ) {
    try {
      return JSON.stringify({
        status: 200,
        body: await this.command(account, action, input, agent),
      });
    } catch (error) {
      return JSON.stringify({
        status: error instanceof SupportError ? error.status : 503,
        body: {
          error:
            error instanceof SupportError
              ? error.message
              : "Support is temporarily unavailable",
        },
      });
    }
  }
  private accountName() {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM support_meta WHERE id='account'",
      )
      .toArray()[0];
    if (!row) throw new Error("Account context missing");
    return row.value;
  }
  private checkDeleted() {
    if (
      this.ctx.storage.sql
        .exec("SELECT id FROM support_meta WHERE id='deleted'")
        .toArray().length
    )
      throw new SupportError(410, "Support account was deleted");
  }
  async assertLive(context: {
    account: string;
    id: string;
    generation: number;
  }) {
    this.checkDeleted();
    if (context.account !== this.accountName())
      throw new SupportError(403, "Account mismatch");
    this.store.live(context.id, context.generation);
  }
  async command(
    account: string,
    action: string,
    input: Record<string, unknown>,
    agent: string | null = null,
  ): Promise<unknown> {
    this.checkDeleted();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO support_meta VALUES ('account',?)",
      account,
    );
    if (account !== this.accountName())
      throw new SupportError(403, "Account mismatch");
    if (["request", "share"].includes(action) && this.currentRole() !== "owner")
      throw new SupportError(
        403,
        "Diagnostic sharing is restricted to the developer",
      );
    const id =
      typeof input.conversationId === "string"
        ? identifier(input.conversationId)
        : "";
    if (agent) {
      if (
        !["list", "create"].includes(action) &&
        (!id || !this.store.get(id).agentAccess)
      )
        throw new SupportError(
          403,
          "Owner approval for this support conversation is required",
        );
      if (
        ![
          "list",
          "create",
          "read",
          "send",
          "request",
          "decline",
          "readCursor",
          "resolve",
          "reopen",
        ].includes(action)
      )
        throw new SupportError(403, "Use the owner app for this action");
    }
    let result: unknown;
    switch (action) {
      case "list":
        result = {
          conversations: this.store
            .list()
            .filter((c) => !agent || this.store.get(c.id).agentAccess),
        };
        break;
      case "create":
        result = snapshot(
          this.ctx.storage.transactionSync(() =>
            this.store.create(identifier(input.id), input.title),
          ),
        );
        break;
      case "read": {
        const before =
          input.before === undefined ? undefined : Number(input.before);
        if (
          before !== undefined &&
          (!Number.isSafeInteger(before) || before < 1)
        )
          throw new SupportError(400, "Invalid cursor");
        const c = this.store.get(id);
        result = {
          ...snapshot(c, before),
          jobs: this.store
            .jobs()
            .filter((j) => j.conversationId === id && j.kind === "codex")
            .map((j) => ({ id: j.id, status: j.status, result: j.result })),
          capabilities: this.capabilities(),
        };
        break;
      }
      case "send":
        result = snapshot(
          this.store.message(id, identifier(input.id), "user", input.text),
        );
        break;
      case "resolve":
      case "reopen":
        result = snapshot(
          this.store.update(id, {
            status: action === "resolve" ? "resolved" : "open",
          }),
        );
        break;
      case "update": {
        const c = this.store.update(id, input);
        if (input.autoReply === false) await this.purgeTurns(c);
        result = snapshot(c);
        break;
      }
      case "readCursor":
        result = snapshot(
          this.store.update(id, { readThrough: input.readThrough }),
        );
        break;
      case "request": {
        const c = this.store.live(id);
        result = this.store.request(
          id,
          identifier(input.id),
          input.reason,
          input.selector,
          c.generation,
        );
        break;
      }
      case "decline":
        result = snapshot(this.store.decline(id, identifier(input.requestId)));
        break;
      case "share": {
        if (input.accepted !== true)
          throw new SupportError(
            403,
            "Review and accept this snapshot on the owner device first",
          );
        const c = this.store.live(id, Number(input.generation)),
          content = typeof input.content === "string" ? input.content : "",
          attachmentId = identifier(input.id);
        text(content, 128000);
        const category = identifier(input.category),
          capturedAt = Number(input.capturedAt);
        if (
          !Number.isSafeInteger(capturedAt) ||
          capturedAt < 0 ||
          capturedAt > Date.now() + 60000
        )
          throw new SupportError(400, "Invalid capture time");
        if (encoder.encode(content).byteLength > 128000)
          throw new SupportError(413, "Snapshot exceeds 128 KB");
        const hash = await digest(content);
        if (hash !== input.digest)
          throw new SupportError(
            409,
            "Approved snapshot digest does not match",
          );
        const cipher = await encrypt(
          this.env.SUPPORT_ENCRYPTION_KEY,
          content,
          `${account}:${id}:${attachmentId}`,
        );
        result = snapshot(
          this.store.attach(
            id,
            c.generation,
            {
              id: attachmentId,
              requestId:
                input.requestId === null ? null : identifier(input.requestId),
              category,
              digest: hash,
              bytes: encoder.encode(content).byteLength,
              capturedAt,
              removed: false,
            },
            cipher,
          ),
        );
        break;
      }
      case "archive":
      case "delete": {
        const c = this.store.beginCleanup(id, action === "delete");
        await this.purgeTurns(c);
        result = this.store.finishCleanup(id);
        this.store.job(
          c,
          `cleanup-${c.generation}`,
          "discord",
          JSON.stringify({
            action: action === "delete" ? "delete-thread" : "archive-thread",
          }),
        );
        break;
      }
      case "device": {
        const deviceId = identifier(input.id);
        if (input.token === null) {
          const previous = this.ctx.storage.sql
            .exec<{ value: string }>(
              "SELECT value FROM support_devices WHERE id=?",
              deviceId,
            )
            .toArray()[0];
          if (previous)
            await this.env.SupportDirectory.getByName("support").releaseDevice(
              await digest(JSON.parse(previous.value).token),
              account,
              deviceId,
            );
          this.ctx.storage.sql.exec(
            "DELETE FROM support_devices WHERE id=?",
            deviceId,
          );
        } else {
          const token = text(input.token, 300);
          if (
            !/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token)
          )
            throw new SupportError(400, "Invalid Expo push token");
          await this.env.SupportDirectory.getByName("support").claimDevice(
            await digest(token),
            account,
            deviceId,
          );
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO support_devices VALUES (?,?)",
            deviceId,
            JSON.stringify({ token }),
          );
        }
        result = { saved: true };
        break;
      }
      case "deleteAccount": {
        for (const entry of this.store.list()) {
          const c = this.store.beginCleanup(entry.id, true);
          await this.purgeTurns(c);
          this.store.finishCleanup(entry.id);
          this.store.job(
            c,
            `cleanup-${c.generation}`,
            "discord",
            JSON.stringify({ action: "delete-thread" }),
          );
        }
        await this.env.SupportDirectory.getByName("support").forgetDevices(
          account,
        );
        this.ctx.storage.sql.exec("DELETE FROM support_devices");
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO support_meta VALUES ('deleted','true')",
        );
        result = { deleted: true };
        break;
      }
      default:
        throw new SupportError(400, "Unknown support action");
    }
    // Reads repair the small admission/scheduling gap following an interrupted write.
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return result;
  }
  setRole(value: string | null) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO support_meta VALUES ('role',?)",
      JSON.stringify({
        role: supportRole(value),
        expiresAt: Date.now() + SUPPORT_ROLE_TTL_MS,
      }),
    );
  }
  currentRole(): SupportRole {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM support_meta WHERE id='role'")
      .toArray()[0];
    if (!row) return "guest";
    const saved = JSON.parse(row.value);
    return saved.expiresAt > Date.now() ? supportRole(saved.role) : "guest";
  }
  async authorizeTool(
    context: { account: string; id: string; generation: number },
    tool: string,
  ) {
    await this.assertLive(context);
    if (!canUseSupportTool(this.currentRole(), tool))
      throw new SupportError(
        403,
        "This support tool is unavailable for your account",
      );
  }
  private capabilities(): string[] {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM support_meta WHERE id='capabilities'",
      )
      .toArray()[0];
    return row ? JSON.parse(row.value) : ["logs", "manual"];
  }
  setCapabilities(values: string[]) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO support_meta VALUES ('capabilities',?)",
      JSON.stringify(values.slice(0, 30).map(identifier)),
    );
  }
  private async purgeTurns(c: Conversation) {
    for (const job of this.store
      .jobs()
      .filter((j) => j.conversationId === c.id && j.kind === "pi"))
      await this.env.SupportTurn.getByName(
        turnName(this.accountName(), c, job),
      ).purge();
  }
  async agentAction(
    context: { account: string; id: string; generation: number },
    action: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const tools: Record<string, string> = {
      request: "request_support_data",
      attachment: "read_support_attachment",
      ticket: "create_support_ticket",
      codex: "dispatch_support_codex",
    };
    const tool = tools[action];
    if (!tool) throw new SupportError(400, "Unknown agent action");
    await this.authorizeTool(context, tool);
    const c = this.store.live(context.id, context.generation);
    const actionId = (
      await digest(JSON.stringify({ context, action, input }))
    ).slice(0, 40);
    if (action === "request")
      return this.store.request(
        c.id,
        actionId,
        input.reason,
        input.selector,
        c.generation,
      );
    if (action === "attachment") {
      const id = identifier(input.id),
        offset = Number(input.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new SupportError(400, "Invalid attachment offset");
      const cipher = this.store.attachment(c.id, id, c.generation);
      const content = await decrypt(
        this.env.SUPPORT_ENCRYPTION_KEY,
        cipher,
        `${context.account}:${c.id}:${id}`,
      );
      await this.assertLive(context);
      return {
        id,
        text: content.slice(offset, offset + 16000),
        totalCharacters: content.length,
        nextOffset: offset + 16000 < content.length ? offset + 16000 : null,
      };
    }
    if (action === "ticket")
      return this.ticket(
        context,
        actionId,
        text(input.title, 200),
        text(input.body, 12000),
      );
    if (action === "codex") {
      const title = text(input.title, 200),
        instructions = text(input.instructions, 12000),
        repository = supportRepository(this.env),
        ref = text(this.env.SUPPORT_GITHUB_REF, 200);
      this.store.job(
        c,
        `codex-${actionId}`,
        "codex",
        JSON.stringify({
          title,
          instructions,
          repository,
          ref,
        }),
      );
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return {
        id: `codex-${actionId}`,
        status: "queued",
        repository,
        ref,
      };
    }
    throw new SupportError(400, "Unknown agent action");
  }
  private async ticket(
    context: { account: string; id: string; generation: number },
    id: string,
    title: string,
    body: string,
  ) {
    const c = this.store.live(context.id, context.generation),
      repository = supportRepository(this.env),
      ticketKey = `ticket-${repository}-${id}`,
      marker = `<!-- isobot:support:${id} -->`;
    const saved = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM support_meta WHERE id=?",
        ticketKey,
      )
      .toArray()[0];
    if (saved) return JSON.parse(saved.value);
    if (!this.env.GITHUB_TOKEN)
      throw new SupportError(503, "GitHub is not configured");
    // List rather than search to avoid indexing delay on uncertain retries.
    const recent = (await this.github(
      "/issues?state=all&per_page=100",
      "GET",
    )) as { body?: string; html_url?: string; number?: number }[];
    const prior = recent.find((issue) => issue.body?.includes(marker));
    await this.authorizeTool(context, "create_support_ticket");
    const result =
      prior ??
      (await this.github("/issues", "POST", {
        title,
        body: `${body}\n\n${marker}`,
      }));
    const value = record(result);
    if (typeof value.html_url !== "string")
      throw new Error("GitHub returned no issue URL");
    await this.assertLive(context);
    const issue = { url: value.html_url, number: value.number, repository };
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO support_meta VALUES (?,?)",
      ticketKey,
      JSON.stringify(issue),
    );
    this.store.message(
      c.id,
      `ticket-${id}`,
      "pi",
      `Recorded this in ${issue.url}`,
      c.generation,
    );
    return issue;
  }
  private async github(
    path: string,
    method: string,
    body?: unknown,
    repository = supportRepository(this.env),
  ) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "isobot-support",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub failed (${response.status})`);
    }
    if (response.status === 204) {
      await response.body?.cancel();
      return { accepted: true };
    }
    return readJson(response, 1000000);
  }
  async alarm() {
    const allJobs = this.store.jobs();
    const firstPiJob = new Map<string, string>();
    for (const job of allJobs)
      if (
        job.kind === "pi" &&
        ["queued", "running"].includes(job.status) &&
        !firstPiJob.has(job.conversationId)
      )
        firstPiJob.set(job.conversationId, job.id);
    const jobs = allJobs.filter(
      (j) =>
        j.kind !== "discord" &&
        ["queued", "running"].includes(j.status) &&
        j.availableAt <= Date.now(),
    );
    for (const job of jobs.slice(0, 8)) {
      if (job.kind === "discord") continue;
      let c: Conversation;
      try {
        c = this.store.live(job.conversationId, job.generation);
      } catch {
        job.status = "cancelled";
        this.store.saveJob(job);
        continue;
      }
      try {
        if (job.kind === "pi") {
          if (!c.autoReply) {
            job.status = "cancelled";
            this.store.saveJob(job);
            continue;
          }
          if (firstPiJob.get(c.id) !== job.id) continue;
          const turn = this.env.SupportTurn.getByName(
            turnName(this.accountName(), c, job),
          );
          await turn.start({
            account: this.accountName(),
            conversation: { ...c, messages: c.messages.slice(-30) },
            operationId: job.id,
            capabilities:
              this.currentRole() === "owner" ? this.capabilities() : [],
            role: this.currentRole(),
          });
          const result = await turn.status(job.id);
          if (result.status === "queued" || result.status === "running") {
            job.status = "running";
            job.availableAt = Date.now() + 3000;
            this.store.saveJob(job);
            continue;
          }
          this.store.live(c.id, job.generation);
          if (result.text.trim())
            this.store.message(
              c.id,
              `reply-${(await digest(`${c.id}:${job.id}`)).slice(0, 40)}`,
              "pi",
              result.text.slice(0, 16000),
              job.generation,
            );
          await turn.purge();
          job.result = result.status;
          job.status = result.status === "done" ? "done" : "failed";
        } else if (job.kind === "push") {
          for (const row of this.ctx.storage.sql
            .exec<{ id: string; value: string }>(
              "SELECT * FROM support_devices",
            )
            .toArray()) {
            this.store.live(c.id, job.generation);
            const { token } = JSON.parse(row.value) as { token: string };
            if (
              !(await this.env.SupportDirectory.getByName("support").ownsDevice(
                await digest(token),
                this.accountName(),
                row.id,
              ))
            )
              continue;
            this.store.live(c.id, job.generation);
            const response = await fetch(
              "https://exp.host/--/api/v2/push/send",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  to: token,
                  title: "myself.md support",
                  body: job.payload,
                  channelId: "support",
                  data: { conversationId: c.id },
                }),
                signal: AbortSignal.timeout(15000),
              },
            );
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error("Push provider unavailable");
            }
            const receipt = (await readJson(response, 32000)) as {
              data?: {
                id?: string;
                status?: string;
                details?: { error?: string };
              };
            };
            if (receipt.data?.details?.error === "DeviceNotRegistered")
              this.ctx.storage.sql.exec(
                "DELETE FROM support_devices WHERE id=?",
                row.id,
              );
            else if (receipt.data?.status !== "ok" || !receipt.data.id)
              throw new Error("Push provider rejected the notification");
            else {
              const receiptId = `receipt-${job.id}-${row.id}`;
              this.store.job(
                c,
                receiptId,
                "push-receipt",
                JSON.stringify({
                  deviceId: row.id,
                  token,
                  ticket: receipt.data.id,
                  expiresAt: Date.now() + 21600000,
                }),
              );
              const queued = this.store
                .jobs()
                .find((j) => j.id === receiptId && j.conversationId === c.id);
              if (queued && queued.status === "queued") {
                queued.availableAt = Date.now() + 900000;
                this.store.saveJob(queued);
              }
            }
          }
          job.status = "done";
        } else if (job.kind === "push-receipt") {
          const pending = JSON.parse(job.payload) as {
            deviceId: string;
            token: string;
            ticket: string;
            expiresAt: number;
          };
          const response = await fetch(
            "https://exp.host/--/api/v2/push/getReceipts",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ids: [pending.ticket] }),
              signal: AbortSignal.timeout(15000),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Push receipts unavailable");
          }
          const received = (await readJson(response, 32000)) as {
            data?: Record<
              string,
              { status?: string; details?: { error?: string } }
            >;
          };
          const receipt = received.data?.[pending.ticket];
          if (!receipt && Date.now() < pending.expiresAt) {
            job.status = "running";
            job.availableAt = Date.now() + 60000;
            this.store.saveJob(job);
            continue;
          }
          if (receipt?.details?.error === "DeviceNotRegistered") {
            const device = this.ctx.storage.sql
              .exec<{ value: string }>(
                "SELECT value FROM support_devices WHERE id=?",
                pending.deviceId,
              )
              .toArray()[0];
            if (device && JSON.parse(device.value).token === pending.token)
              this.ctx.storage.sql.exec(
                "DELETE FROM support_devices WHERE id=?",
                pending.deviceId,
              );
          }
          job.status = receipt?.status === "ok" ? "done" : "failed";
        } else if (job.kind === "codex") {
          if (job.status === "running") {
            job.status = "failed";
            job.result =
              "Implementation task timed out; staff can inspect its workflow run";
            this.store.saveJob(job);
            continue;
          }
          if (
            !canUseSupportTool(this.currentRole(), "dispatch_support_codex")
          ) {
            job.status = "cancelled";
            this.store.saveJob(job);
            continue;
          }
          if (!this.env.GITHUB_TOKEN)
            throw new Error("GitHub workflow credential is not configured");
          const task = JSON.parse(job.payload);
          await this.github(
            "/actions/workflows/support-codex.yml/dispatches",
            "POST",
            {
              ref: task.ref ?? "main",
              inputs: {
                task_id: job.id,
                account: this.accountName(),
                conversation_id: c.id,
                generation: String(job.generation),
                instructions: task.instructions,
                title: task.title,
              },
            },
            task.repository,
          );
          const latest = this.store
            .jobs()
            .find((j) => j.id === job.id && j.conversationId === c.id);
          if (latest && ["done", "failed"].includes(latest.status)) continue;
          job.status = "running";
          job.availableAt = Date.now() + 2100000;
          job.result =
            "Workflow dispatch accepted; implementation result is pending";
        }
        this.store.live(c.id, job.generation);
        this.store.saveJob(job);
      } catch {
        // No data, prompts, or credentials in operational logs.
        const current = this.store
          .jobs()
          .find(
            (j) => j.id === job.id && j.conversationId === job.conversationId,
          );
        if (!current || current.status === "cancelled") continue;
        job.attempts++;
        job.status = job.attempts >= 5 ? "failed" : "queued";
        job.availableAt =
          Date.now() + Math.min(60000, 1000 * 2 ** job.attempts);
        this.store.saveJob(job);
        console.warn(
          JSON.stringify({
            event: "support_job_failed",
            kind: job.kind,
            attempts: job.attempts,
          }),
        );
      }
    }
    const remaining = this.store
      .jobs()
      .filter(
        (j) => ["queued", "running"].includes(j.status) && j.kind !== "discord",
      );
    if (remaining.length)
      await this.ctx.storage.setAlarm(
        Math.max(
          Date.now() + 3000,
          Math.min(...remaining.map((j) => j.availableAt)),
        ),
      );
  }
  taskResult(input: Record<string, unknown>) {
    const id = identifier(input.id),
      conversation = identifier(input.conversationId);
    this.store.live(conversation, Number(input.generation));
    const job = this.store
      .jobs()
      .find(
        (j) =>
          j.id === id &&
          j.conversationId === conversation &&
          j.kind === "codex",
      );
    if (!job) throw new SupportError(404, "Task not found");
    if (!["running", "completed", "failed"].includes(String(input.status)))
      throw new SupportError(400, "Invalid task status");
    if (job.status === "done" || job.status === "failed")
      return { saved: true };
    if (input.status === "completed") {
      const url = text(input.url, 300),
        prefix = `https://github.com/${JSON.parse(job.payload).repository}/pull/`;
      if (
        !url.startsWith(prefix) ||
        !/^[1-9][0-9]*$/.test(url.slice(prefix.length))
      )
        throw new SupportError(400, "Invalid PR target");
      job.status = "done";
      job.result = url;
      this.store.message(
        conversation,
        `task-${id}`,
        "pi",
        `A first implementation pass is ready for review: ${url}`,
        job.generation,
      );
    } else {
      job.status = input.status === "failed" ? "failed" : "running";
      job.result =
        input.status === "failed"
          ? "Implementation task failed"
          : "Codex is investigating";
      job.availableAt = Date.now() + 1800000;
    }
    this.store.saveJob(job);
    return { saved: true };
  }
  bridgeJobs() {
    return this.store
      .jobs()
      .filter((j) => j.kind === "discord" && j.status === "queued")
      .slice(0, 20);
  }
  bridgeAck(id: string, conversation: string) {
    const job = this.store
      .jobs()
      .find((j) => j.id === id && j.conversationId === conversation);
    if (job && job.status === "queued") {
      job.status = "done";
      this.store.saveJob(job);
    }
    return { saved: true };
  }
  async staffReply(conversation: string, id: string, content: string) {
    try {
      const current = this.store.live(conversation);
      const existing = current.messages.find((m) => m.id === `staff-${id}`);
      if (existing) {
        if (existing.author !== "staff" || existing.text !== content)
          throw new SupportError(409, "Staff reply conflict");
        return snapshot(current);
      }
      if (current.autoReply) {
        const paused = this.store.update(conversation, { autoReply: false });
        await this.purgeTurns(paused);
      }
      const result = snapshot(
        this.store.message(conversation, `staff-${id}`, "staff", content),
      );
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return result;
    } catch (error) {
      if (error instanceof SupportError && [404, 409].includes(error.status))
        return { ignored: true };
      throw error;
    }
  }
}

/** Directory stores only account routing and private Discord thread mappings. */
export class SupportDirectory extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS support_accounts (id TEXT PRIMARY KEY,seen INTEGER); CREATE TABLE IF NOT EXISTS support_threads (id TEXT PRIMARY KEY,account TEXT,conversation TEXT); CREATE TABLE IF NOT EXISTS support_push_owners (id TEXT PRIMARY KEY,account TEXT,device TEXT);",
    );
  }
  claimDevice(id: string, account: string, device: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO support_push_owners VALUES (?,?,?)",
      id,
      account,
      device,
    );
  }
  releaseDevice(id: string, account: string, device: string) {
    this.ctx.storage.sql.exec(
      "DELETE FROM support_push_owners WHERE id=? AND account=? AND device=?",
      id,
      account,
      device,
    );
  }
  ownsDevice(id: string, account: string, device: string) {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT id FROM support_push_owners WHERE id=? AND account=? AND device=?",
          id,
          account,
          device,
        )
        .toArray().length === 1
    );
  }
  forgetDevices(account: string) {
    this.ctx.storage.sql.exec(
      "DELETE FROM support_push_owners WHERE account=?",
      account,
    );
  }
  remember(account: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO support_accounts VALUES (?,0)",
      account,
    );
  }
  accounts() {
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM support_accounts ORDER BY seen LIMIT 20",
      )
      .toArray();
    for (const row of rows)
      this.ctx.storage.sql.exec(
        "UPDATE support_accounts SET seen=? WHERE id=?",
        Date.now(),
        row.id,
      );
    return rows.map((r) => r.id);
  }
  thread(id: string, account: string, conversation: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO support_threads VALUES (?,?,?)",
      id,
      account,
      conversation,
    );
  }
  threads() {
    return this.ctx.storage.sql
      .exec<{ id: string; account: string; conversation: string }>(
        "SELECT * FROM support_threads LIMIT 1000",
      )
      .toArray();
  }
  removeThread(id: string) {
    this.ctx.storage.sql.exec("DELETE FROM support_threads WHERE id=?", id);
  }
  lookup(id: string) {
    return (
      this.ctx.storage.sql
        .exec<{ account: string; conversation: string }>(
          "SELECT account,conversation FROM support_threads WHERE id=?",
          id,
        )
        .toArray()[0] ?? null
    );
  }
}

function bridgeJobIdentifier(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
    throw new SupportError(400, "Invalid job identifier");
  return value;
}

async function readSupportJson(request: Request, maxBytes = 256000) {
  try {
    return await readJson(request, maxBytes);
  } catch (error) {
    throw new SupportError(
      error instanceof Error && error.message === "Request body too large"
        ? 413
        : 400,
      "Invalid support request body",
    );
  }
}

export async function handleSupportRequest(
  request: Request,
  env: Bindings,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const token =
        path === "/api/support-bridge/task"
          ? env.SUPPORT_TASK_TOKEN
          : path.startsWith("/api/support-bridge/")
            ? env.SUPPORT_BRIDGE_TOKEN
            : env.SUPPORT_SERVICE_TOKEN,
      provided = request.headers.get("Authorization") ?? "";
    if (
      !token ||
      !crypto.subtle.timingSafeEqual(
        encoder.encode(await digest(provided)),
        encoder.encode(await digest(`Bearer ${token}`)),
      )
    )
      throw new SupportError(401, "Unauthorized");
    const url = new URL(request.url),
      directory = env.SupportDirectory.getByName("support");
    if (url.pathname === "/api/support-bridge/jobs") {
      const jobs = [];
      for (const account of await directory.accounts())
        for (const job of await env.SupportAccount.getByName(
          account,
        ).bridgeJobs())
          jobs.push({ ...job, account });
      return Response.json(
        { jobs },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (url.pathname === "/api/support-bridge/threads")
      return Response.json({ threads: await directory.threads() });
    if (url.pathname === "/api/support-bridge/event") {
      const v = record(await readSupportJson(request));
      const route = await directory.lookup(identifier(v.threadId));
      if (!route) throw new SupportError(404, "Support thread not found");
      const result = await env.SupportAccount.getByName(
        route.account,
      ).staffReply(route.conversation, identifier(v.id), text(v.text, 16000));
      return Response.json(result);
    }
    if (url.pathname === "/api/support-bridge/task") {
      const v = record(await readSupportJson(request));
      return Response.json(
        await env.SupportAccount.getByName(text(v.account, 150)).taskResult(v),
      );
    }
    if (url.pathname === "/api/support-bridge/ack") {
      const v = record(await readSupportJson(request));
      const account = text(v.account, 150),
        conversation = identifier(v.conversationId);
      if (v.threadId) {
        if (v.deleted === true)
          await directory.removeThread(identifier(v.threadId));
        else
          await directory.thread(identifier(v.threadId), account, conversation);
      }
      return Response.json(
        await env.SupportAccount.getByName(account).bridgeAck(
          bridgeJobIdentifier(v.id),
          conversation,
        ),
      );
    }
    const owner = text(request.headers.get("X-Support-Owner"), 1000),
      account = `myself-${await digest(owner)}`;
    await directory.remember(account);
    const input =
      request.method === "GET"
        ? Object.fromEntries(url.searchParams)
        : record(await readSupportJson(request, 200000));
    const action =
      request.method === "GET"
        ? input.conversationId
          ? "read"
          : "list"
        : text(input.action, 40);
    const service = env.SupportAccount.getByName(account);
    await service.setRole(
      owner.startsWith("support-guest:")
        ? "guest"
        : request.headers.get("X-Support-Role"),
    );
    if (Array.isArray(input.capabilities))
      await service.setCapabilities(input.capabilities.map(identifier));
    const result = JSON.parse(
      await service.handle(
        account,
        action,
        input,
        request.headers.get("X-Support-Agent"),
      ),
    ) as { status: number; body: unknown };
    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof SupportError
            ? error.message
            : "Support is temporarily unavailable",
      },
      {
        status: error instanceof SupportError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
