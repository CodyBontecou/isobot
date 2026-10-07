export type NoteMode = "prompt" | "memory";

export interface NoteInput {
  id: string;
  mode: NoteMode;
  markdown: string;
  payload: Record<string, unknown>;
}

export interface NoteResult {
  operationId: string;
  status: "done" | "unanswered";
  text: string;
  reason?: string;
}

export interface StoredNote extends NoteInput {
  sequence: number;
  receivedAt: string;
  result?: NoteResult;
}

export interface NoteMetadata {
  sequence: number;
  id: string;
  mode: NoteMode;
  receivedAt: string;
  preview: string;
  status: "stored" | "queued" | NoteResult["status"];
}

type NoteRow = {
  sequence: number;
  id: string;
  mode: NoteMode;
  markdown: string;
  payload_json: string;
  received_at: string;
  input_digest: string;
  result_json: string | null;
}

type MetadataRow = Pick<NoteRow, "sequence" | "id" | "mode" | "received_at"> & {
  preview: string;
  result_status: NoteResult["status"] | null;
};

/** Canonicalize JSON values after serialization, preserving array order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20;
}

function storedNote(row: NoteRow): StoredNote {
  return {
    sequence: row.sequence,
    id: row.id,
    mode: row.mode,
    markdown: row.markdown,
    payload: JSON.parse(row.payload_json),
    receivedAt: row.received_at,
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as NoteResult }),
  };
}

function metadata(row: MetadataRow): NoteMetadata {
  return {
    sequence: row.sequence,
    id: row.id,
    mode: row.mode,
    receivedAt: row.received_at,
    preview: row.preview,
    status: row.result_status ?? (row.mode === "memory" ? "stored" : "queued"),
  };
}

/** Exact Markdown and transport metadata, alongside Pi's durable conversation tables. */
export class NoteArchive {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS api_captured_notes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('prompt', 'memory')),
      markdown TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      result_json TEXT
    )`);
  }

  async remember(input: NoteInput): Promise<
    { conflict: true } | { conflict: false; duplicate: boolean; note: StoredNote }
  > {
    const payloadJson = JSON.stringify(input.payload);
    const canonical = canonicalJson({ mode: input.mode, markdown: input.markdown, payload: JSON.parse(payloadJson) });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    // Insertion and comparison are synchronous, so retries cannot replace an accepted capture.
    const existed = this.sql.exec<{ id: string }>("SELECT id FROM api_captured_notes WHERE id = ?", input.id).toArray().length > 0;
    this.sql.exec(
      "INSERT OR IGNORE INTO api_captured_notes (id, mode, markdown, payload_json, received_at, input_digest) VALUES (?, ?, ?, ?, ?, ?)",
      input.id, input.mode, input.markdown, payloadJson, new Date().toISOString(), hex,
    );
    const row = this.sql.exec<NoteRow>("SELECT * FROM api_captured_notes WHERE id = ?", input.id).one();
    if (row.input_digest !== hex) return { conflict: true };
    return { conflict: false, duplicate: existed, note: storedNote(row) };
  }

  get(id: string): StoredNote | null {
    const row = this.sql.exec<NoteRow>("SELECT * FROM api_captured_notes WHERE id = ?", id).toArray()[0];
    return row ? storedNote(row) : null;
  }

  list(options: { before?: number; limit: number }): { items: NoteMetadata[]; nextCursor?: number } {
    if (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 1)) {
      throw new RangeError("Invalid notes cursor");
    }
    const limit = boundedLimit(options.limit);
    const rows = options.before === undefined
      ? this.sql.exec<MetadataRow>(
          "SELECT sequence, id, mode, received_at, json_extract(result_json, '$.status') AS result_status, substr(markdown, 1, 240) AS preview FROM api_captured_notes ORDER BY sequence DESC LIMIT ?",
          limit + 1,
        ).toArray()
      : this.sql.exec<MetadataRow>(
          "SELECT sequence, id, mode, received_at, json_extract(result_json, '$.status') AS result_status, substr(markdown, 1, 240) AS preview FROM api_captured_notes WHERE sequence < ? ORDER BY sequence DESC LIMIT ?",
          options.before, limit + 1,
        ).toArray();
    const items = rows.slice(0, limit).map(metadata);
    return { items, ...(rows.length > limit ? { nextCursor: items[items.length - 1].sequence } : {}) };
  }

  search(query: string, limit: number): (NoteMetadata & { snippet: string })[] {
    const count = Math.min(10, boundedLimit(limit));
    if (!query.trim()) return this.list({ limit: count }).items.map(item => ({ ...item, snippet: item.preview }));
    const rows = this.sql.exec<MetadataRow & { snippet: string }>(
      `SELECT sequence, id, mode, received_at, json_extract(result_json, '$.status') AS result_status, substr(markdown, 1, 240) AS preview,
        substr(markdown, max(1, instr(lower(markdown), lower(?)) - 100), 480) AS snippet
      FROM api_captured_notes WHERE instr(lower(markdown), lower(?)) > 0 ORDER BY sequence DESC LIMIT ?`,
      query, query, count,
    ).toArray();
    return rows.map(row => ({ ...metadata(row), snippet: row.snippet }));
  }

  /** Pi already persists results; retain the first terminal result in the capture's public record. */
  saveResult(id: string, result: NoteResult): void {
    const note = this.sql.exec<{ mode: NoteMode }>("SELECT mode FROM api_captured_notes WHERE id = ?", id).toArray()[0];
    if (!note) throw new Error("Captured note not found");
    if (note.mode !== "prompt") throw new Error("Memory notes have no Pi operation");
    this.sql.exec(
      "UPDATE api_captured_notes SET result_json = ? WHERE id = ? AND result_json IS NULL",
      JSON.stringify(result), id,
    );
  }
}
