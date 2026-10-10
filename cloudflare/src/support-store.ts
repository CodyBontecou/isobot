/** Customer support state. Each instance is routed from a verified host account. */
export class SupportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface DataSelector {
  category: string;
  from: number;
  to: number;
  operations: string[];
  issuesOnly: boolean;
}
export interface DataRequest {
  id: string;
  reason: string;
  selector: DataSelector;
  expiresAt: number;
  status: "pending" | "shared" | "declined" | "expired" | "cancelled";
}
export interface SupportMessage {
  id: string;
  sequence: number;
  author: "user" | "pi" | "staff";
  text: string;
  createdAt: string;
}
export interface Attachment {
  id: string;
  requestId: string | null;
  category: string;
  digest: string;
  bytes: number;
  capturedAt: number;
  removed: boolean;
}
export interface Conversation {
  id: string;
  title: string;
  status: "open" | "resolved" | "archiving" | "archived" | "deleting";
  generation: number;
  readThrough: number;
  agentAccess: boolean;
  autoReply: boolean;
  messages: SupportMessage[];
  requests: DataRequest[];
  attachments: Attachment[];
  createdAt: string;
  updatedAt: string;
}
export interface SupportJob {
  id: string;
  conversationId: string;
  generation: number;
  kind: "pi" | "discord" | "push" | "push-receipt" | "codex";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  payload: string;
  result: string | null;
  attempts: number;
  availableAt: number;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SupportError(400, "Expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 1800): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new SupportError(400, "Invalid text");
  return value.trim();
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new SupportError(400, "Invalid identifier");
  return value;
}
export function selector(value: unknown): DataSelector {
  const v = record(value);
  const from = Number(v.from),
    to = Number(v.to);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to > Date.now() + 60000
  )
    throw new SupportError(400, "Invalid data time range");
  const operations = v.operations ?? [];
  if (!Array.isArray(operations) || operations.length > 20)
    throw new SupportError(400, "Invalid operations");
  if (v.issuesOnly !== undefined && typeof v.issuesOnly !== "boolean")
    throw new SupportError(400, "Invalid issue filter");
  return {
    category: identifier(v.category),
    from,
    to,
    operations: operations.map((v) => text(v, 80)),
    issuesOnly: v.issuesOnly === true,
  };
}

export class SupportStore {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS support_conversations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS support_attachments (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, ciphertext TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS support_jobs (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS support_receipts (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS support_devices (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS support_meta (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  private save(c: Conversation) {
    c.updatedAt = new Date().toISOString();
    this.sql.exec(
      "INSERT OR REPLACE INTO support_conversations VALUES (?,?)",
      c.id,
      JSON.stringify(c),
    );
  }
  get(id: string): Conversation {
    const row = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM support_conversations WHERE id=?",
        identifier(id),
      )
      .toArray()[0];
    if (!row) throw new SupportError(404, "Conversation not found");
    const c: Conversation = JSON.parse(row.value);
    for (const r of c.requests)
      if (r.status === "pending" && r.expiresAt <= Date.now())
        r.status = "expired";
    return c;
  }
  live(id: string, generation?: number): Conversation {
    const c = this.get(id);
    if (
      c.status !== "open" ||
      (generation !== undefined && generation !== c.generation)
    )
      throw new SupportError(409, "Conversation is closed or changed");
    return c;
  }
  list() {
    return this.sql
      .exec<{ value: string }>(
        "SELECT value FROM support_conversations ORDER BY rowid DESC LIMIT 100",
      )
      .toArray()
      .map((row) => {
        const c: Conversation = JSON.parse(row.value);
        return {
          id: c.id,
          title: c.title,
          status: c.status,
          updatedAt: c.updatedAt,
          unreadCount: c.messages.filter(
            (m) => m.author !== "user" && m.sequence > c.readThrough,
          ).length,
        };
      });
  }
  receipt(
    id: string,
    conversation: string,
    input: string,
  ): unknown | undefined {
    const row = this.sql
      .exec<{ input: string; result: string; conversation: string }>(
        "SELECT * FROM support_receipts WHERE id=?",
        identifier(id),
      )
      .toArray()[0];
    if (!row) return undefined;
    if (row.conversation !== conversation || row.input !== input)
      throw new SupportError(
        409,
        "Request ID already used with different content",
      );
    return JSON.parse(row.result);
  }
  remember(id: string, conversation: string, input: string, result: unknown) {
    this.sql.exec(
      "INSERT INTO support_receipts VALUES (?,?,?,?)",
      id,
      conversation,
      input,
      JSON.stringify(result),
    );
  }
  create(id: string, titleValue: unknown) {
    identifier(id);
    const title = text(titleValue, 120);
    const prior = this.receipt(id, id, title);
    if (prior) return this.get(id);
    if (
      this.sql
        .exec("SELECT id FROM support_conversations WHERE id=?", id)
        .toArray().length
    )
      throw new SupportError(409, "Conversation ID already exists");
    if (
      this.sql
        .exec(
          "SELECT id FROM support_meta WHERE id=?",
          `deleted-conversation:${id}`,
        )
        .toArray().length
    )
      throw new SupportError(409, "Conversation ID was deleted; use a new ID");
    if (this.list().length >= 100)
      throw new SupportError(429, "Conversation limit reached");
    const now = new Date().toISOString();
    const c: Conversation = {
      id,
      title,
      status: "open",
      generation: 1,
      readThrough: 0,
      agentAccess: false,
      autoReply: true,
      messages: [],
      requests: [],
      attachments: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(c);
    const started = this.message(id, id, "user", title);
    this.remember(id, id, title, { id });
    return started;
  }
  message(
    conversation: string,
    id: string,
    author: SupportMessage["author"],
    value: unknown,
    generation?: number,
  ) {
    const c = this.live(conversation, generation),
      content = text(value, author === "user" ? 1800 : 16000);
    const existing = c.messages.find((m) => m.id === identifier(id));
    if (existing) {
      if (existing.text !== content || existing.author !== author)
        throw new SupportError(409, "Message ID conflict");
      return c;
    }
    if (c.messages.length >= 1000)
      throw new SupportError(429, "Conversation message limit reached");
    if (
      author === "user" &&
      c.messages.filter(
        (m) =>
          m.author === "user" && Date.parse(m.createdAt) > Date.now() - 3600000,
      ).length >= 30
    )
      throw new SupportError(429, "Please wait before sending more messages");
    c.messages.push({
      id,
      author,
      text: content,
      sequence: (c.messages.at(-1)?.sequence ?? 0) + 1,
      createdAt: new Date().toISOString(),
    });
    this.save(c);
    if (author === "user" && c.autoReply)
      this.job(c, `pi-${id}`, "pi", JSON.stringify({ messageId: id }));
    if (author !== "staff")
      this.job(
        c,
        `discord-${id}`,
        "discord",
        JSON.stringify({ id, text: content, author }),
      );
    if (author !== "user") this.job(c, `push-${id}`, "push", "Support replied");
    return c;
  }
  update(id: string, input: Record<string, unknown>) {
    const c = this.get(id);
    if (c.status === "archiving" || c.status === "deleting")
      throw new SupportError(409, "Cleanup is in progress");
    if (input.readThrough !== undefined) {
      const seq = Number(input.readThrough);
      if (
        !Number.isSafeInteger(seq) ||
        seq < 0 ||
        seq > (c.messages.at(-1)?.sequence ?? 0)
      )
        throw new SupportError(400, "Invalid read cursor");
      c.readThrough = Math.max(c.readThrough, seq);
    }
    for (const field of ["agentAccess", "autoReply"] as const)
      if (input[field] !== undefined) {
        if (typeof input[field] !== "boolean")
          throw new SupportError(400, "Invalid preference");
        if (field === "autoReply" && c.autoReply && input[field] === false)
          c.generation++;
        c[field] = input[field];
      }
    if (
      input.status === "open" &&
      (c.status === "archived" || c.status === "resolved")
    )
      c.status = "open";
    else if (input.status === "resolved" && c.status === "open")
      c.status = "resolved";
    else if (input.status !== undefined && input.status !== c.status)
      throw new SupportError(400, "Invalid status transition");
    this.save(c);
    return c;
  }
  request(
    id: string,
    requestId: string,
    reason: unknown,
    selection: unknown,
    generation: number,
  ) {
    const c = this.live(id, generation);
    const r: DataRequest = {
      id: identifier(requestId),
      reason: text(reason, 1000),
      selector: selector(selection),
      expiresAt: Date.now() + 86400000,
      status: "pending",
    };
    const prior = c.requests.find((v) => v.id === r.id);
    if (prior) {
      if (
        prior.reason !== r.reason ||
        JSON.stringify(prior.selector) !== JSON.stringify(r.selector)
      )
        throw new SupportError(409, "Data request ID conflict");
      return prior;
    }
    if (c.requests.length >= 100)
      throw new SupportError(429, "Data request limit reached");
    c.requests.push(r);
    this.save(c);
    this.job(c, `push-${r.id}`, "push", "Support requested data");
    return r;
  }
  decline(id: string, requestId: string) {
    const c = this.live(id),
      r = c.requests.find((r) => r.id === requestId);
    if (!r) throw new SupportError(404, "Data request not found");
    if (r.status === "declined") return c;
    if (r.status !== "pending")
      throw new SupportError(409, "Data request is no longer pending");
    r.status = "declined";
    this.save(c);
    this.job(c, `decline-${requestId}`, "pi", JSON.stringify({ requestId }));
    return c;
  }
  attach(
    id: string,
    generation: number,
    attachment: Attachment,
    ciphertext: string,
  ) {
    const c = this.live(id, generation);
    const prior = c.attachments.find((a) => a.id === attachment.id);
    if (prior) {
      if (
        prior.digest !== attachment.digest ||
        prior.requestId !== attachment.requestId ||
        prior.category !== attachment.category
      )
        throw new SupportError(409, "Attachment ID conflict");
      return c;
    }
    if (
      c.attachments.length >= 20 ||
      c.attachments.reduce((sum, a) => sum + (a.removed ? 0 : a.bytes), 0) +
        attachment.bytes >
        1000000
    )
      throw new SupportError(413, "Conversation attachment limit reached");
    if (attachment.requestId) {
      const r = c.requests.find((r) => r.id === attachment.requestId);
      if (
        !r ||
        r.status !== "pending" ||
        r.selector.category !== attachment.category
      )
        throw new SupportError(409, "Data request is unavailable");
      r.status = "shared";
    }
    this.sql.exec(
      "INSERT INTO support_attachments VALUES (?,?,?)",
      `${c.id}:${attachment.id}`,
      c.id,
      ciphertext,
    );
    c.attachments.push(attachment);
    this.save(c);
    this.job(
      c,
      `attachment-${attachment.id}`,
      "pi",
      JSON.stringify({ attachmentId: attachment.id }),
    );
    return c;
  }
  attachment(id: string, attachmentId: string, generation: number) {
    const c = this.live(id, generation);
    if (!c.attachments.some((a) => a.id === attachmentId && !a.removed))
      throw new SupportError(404, "Attachment unavailable");
    const row = this.sql
      .exec<{ ciphertext: string }>(
        "SELECT ciphertext FROM support_attachments WHERE id=? AND conversation=?",
        `${id}:${attachmentId}`,
        id,
      )
      .toArray()[0];
    if (!row) throw new SupportError(404, "Attachment unavailable");
    return row.ciphertext;
  }
  beginCleanup(id: string, remove: boolean) {
    const c = this.get(id);
    if (c.status !== "archiving" && c.status !== "deleting") c.generation++;
    c.status = remove ? "deleting" : "archiving";
    for (const r of c.requests)
      if (r.status === "pending") r.status = "cancelled";
    this.save(c);
    for (const job of this.jobs())
      if (
        job.conversationId === id &&
        ["queued", "running"].includes(job.status)
      ) {
        job.status = "cancelled";
        this.saveJob(job);
      }
    return c;
  }
  finishCleanup(id: string) {
    const c = this.get(id);
    if (c.status !== "archiving" && c.status !== "deleting")
      throw new SupportError(409, "Cleanup not started");
    this.sql.exec("DELETE FROM support_attachments WHERE conversation=?", id);
    this.sql.exec("DELETE FROM support_receipts WHERE conversation=?", id);
    this.sql.exec("DELETE FROM support_jobs WHERE conversation=?", id);
    if (c.status === "deleting") {
      this.sql.exec(
        "INSERT OR REPLACE INTO support_meta VALUES (?,?)",
        `deleted-conversation:${id}`,
        "true",
      );
      this.sql.exec("DELETE FROM support_conversations WHERE id=?", id);
    } else {
      c.status = "archived";
      c.attachments = c.attachments.map((a) => ({ ...a, removed: true }));
      this.save(c);
    }
    return {
      deleted: c.status === "deleting",
      archived: c.status === "archived",
    };
  }
  job(c: Conversation, id: string, kind: SupportJob["kind"], payload: string) {
    this.sql.exec(
      "INSERT OR IGNORE INTO support_jobs VALUES (?,?,?)",
      `${c.id}:${id}`,
      c.id,
      JSON.stringify({
        id,
        conversationId: c.id,
        generation: c.generation,
        kind,
        payload,
        status: "queued",
        result: null,
        attempts: 0,
        availableAt: Date.now(),
      } satisfies SupportJob),
    );
  }
  jobs(): SupportJob[] {
    return this.sql
      .exec<{ value: string }>(
        "SELECT value FROM support_jobs ORDER BY rowid LIMIT 5000",
      )
      .toArray()
      .map((r) => JSON.parse(r.value));
  }
  saveJob(job: SupportJob) {
    if (job.status === "done" && job.kind !== "codex") {
      this.sql.exec(
        "DELETE FROM support_jobs WHERE id=?",
        `${job.conversationId}:${job.id}`,
      );
      return;
    }
    this.sql.exec(
      "UPDATE support_jobs SET value=? WHERE id=?",
      JSON.stringify(job),
      `${job.conversationId}:${job.id}`,
    );
  }
}
