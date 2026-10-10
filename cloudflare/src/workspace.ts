export const MAX_WORKSPACE_FILE_BYTES = 131_072;
export const MAX_WORKSPACE_FILES = 500;
export const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();

export interface WorkspaceFileMetadata {
  path: string;
  bytes: number;
  revision: number;
  updatedAt: string;
}
export interface WorkspaceFile extends WorkspaceFileMetadata { content: string }
export interface WorkspaceListing {
  files: WorkspaceFileMetadata[];
  totalBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxBytes: number;
}
export type WorkspaceWriteResult =
  | { ok: true; file: WorkspaceFile }
  | { ok: false; error: "conflict"; currentRevision: number | null }
  | { ok: false; error: "capacity" };
export type WorkspaceDeleteResult =
  | { ok: true; deleted: true }
  | { ok: false; error: "conflict"; currentRevision: number | null };

type FileRow = { path: string; content: string; bytes: number; revision: number; updated_at: string };
type MetadataRow = Omit<FileRow, "content">;

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Paths address only this agent's virtual workspace; never host or Pi internal storage. */
export function isWorkspacePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && encoder.encode(path).byteLength <= 256
    && validUnicode(path)
    && !/[\\:\u0000-\u001f\u007f]/.test(path)
    && path.split("/").length <= 16
    && path.split("/").every(part => part.length > 0 && part !== "." && part !== ".." && part.trim() === part);
}

export function isWorkspaceRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isWorkspaceContent(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_WORKSPACE_FILE_BYTES || value.includes("\u0000")) return false;
  // Reject invalid UTF-16 rather than silently replacing it when the file is downloaded as UTF-8.
  return validUnicode(value) && encoder.encode(value).byteLength <= MAX_WORKSPACE_FILE_BYTES;
}

function metadata(row: MetadataRow): WorkspaceFileMetadata {
  return { path: row.path, bytes: row.bytes, revision: row.revision, updatedAt: row.updated_at };
}
function file(row: FileRow): WorkspaceFile { return { ...metadata(row), content: row.content }; }

/** Editable UTF-8 files shared by the console and the agent's registered tools. */
export class Workspace {
  constructor(private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS api_workspace_files (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  list(): WorkspaceListing {
    const rows = this.storage.sql.exec<MetadataRow>(
      "SELECT path, bytes, revision, updated_at FROM api_workspace_files ORDER BY path",
    ).toArray();
    return { files: rows.map(metadata), totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      maxFileBytes: MAX_WORKSPACE_FILE_BYTES, maxFiles: MAX_WORKSPACE_FILES, maxBytes: MAX_WORKSPACE_BYTES };
  }

  get(path: string): WorkspaceFile | null {
    if (!isWorkspacePath(path)) throw new RangeError("Invalid workspace path");
    const row = this.storage.sql.exec<FileRow>("SELECT * FROM api_workspace_files WHERE path = ?", path).toArray()[0];
    return row ? file(row) : null;
  }

  put(path: string, content: string, expectedRevision: number | null): WorkspaceWriteResult {
    if (!isWorkspacePath(path) || !isWorkspaceContent(content)
      || (expectedRevision !== null && !isWorkspaceRevision(expectedRevision))) throw new RangeError("Invalid workspace file");
    return this.storage.transactionSync(() => {
      const current = this.storage.sql.exec<MetadataRow>(
        "SELECT path, bytes, revision, updated_at FROM api_workspace_files WHERE path = ?", path,
      ).toArray()[0];
      if ((current?.revision ?? null) !== expectedRevision) {
        return { ok: false, error: "conflict", currentRevision: current?.revision ?? null };
      }
      const bytes = encoder.encode(content).byteLength;
      const totals = this.storage.sql.exec<{ files: number; bytes: number }>(
        "SELECT count(*) AS files, coalesce(sum(bytes), 0) AS bytes FROM api_workspace_files",
      ).one();
      if ((!current && totals.files >= MAX_WORKSPACE_FILES) || totals.bytes - (current?.bytes ?? 0) + bytes > MAX_WORKSPACE_BYTES) {
        return { ok: false, error: "capacity" };
      }
      // A new global revision on every edit also prevents stale writes after delete-and-recreate.
      this.storage.sql.exec(
        "INSERT OR REPLACE INTO api_workspace_files (path, content, bytes, updated_at) VALUES (?, ?, ?, ?)",
        path, content, bytes, new Date().toISOString(),
      );
      return { ok: true, file: file(this.storage.sql.exec<FileRow>("SELECT * FROM api_workspace_files WHERE path = ?", path).one()) };
    });
  }

  delete(path: string, expectedRevision: number): WorkspaceDeleteResult {
    if (!isWorkspacePath(path) || !isWorkspaceRevision(expectedRevision)) throw new RangeError("Invalid workspace file");
    return this.storage.transactionSync(() => {
      const current = this.storage.sql.exec<{ revision: number }>(
        "SELECT revision FROM api_workspace_files WHERE path = ?", path,
      ).toArray()[0];
      if (current?.revision !== expectedRevision) return { ok: false, error: "conflict", currentRevision: current?.revision ?? null };
      this.storage.sql.exec("DELETE FROM api_workspace_files WHERE path = ? AND revision = ?", path, expectedRevision);
      return { ok: true, deleted: true };
    });
  }

  search(query: string, limit = 10): (WorkspaceFileMetadata & { snippet: string })[] {
    if (query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new RangeError("Invalid workspace search");
    const rows = this.storage.sql.exec<MetadataRow & { snippet: string }>(
      `SELECT path, bytes, revision, updated_at,
        substr(content, max(1, instr(lower(content), lower(?)) - 100), 480) AS snippet
      FROM api_workspace_files WHERE instr(lower(content), lower(?)) > 0 OR instr(lower(path), lower(?)) > 0
      ORDER BY path LIMIT ?`, query, query, query, limit,
    ).toArray();
    return rows.map(row => ({ ...metadata(row), snippet: row.snippet }));
  }
}
