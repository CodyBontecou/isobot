import { readJson } from "./http-body.js";
import { isWorkspaceContent, isWorkspacePath, isWorkspaceRevision, MAX_WORKSPACE_FILE_BYTES,
  type WorkspaceDeleteResult, type WorkspaceFile, type WorkspaceListing, type WorkspaceWriteResult } from "./workspace.js";

const PRIVATE = { "Cache-Control": "no-store" };
export interface WorkspaceAgent {
  workspaceList(): Promise<WorkspaceListing> | WorkspaceListing;
  workspaceRead(path: string): Promise<WorkspaceFile | null> | WorkspaceFile | null;
  workspaceWrite(path: string, content: string, expectedRevision: number | null): Promise<WorkspaceWriteResult> | WorkspaceWriteResult;
  workspaceDelete(path: string, expectedRevision: number): Promise<WorkspaceDeleteResult> | WorkspaceDeleteResult;
  resourcesSnapshot(): Promise<string>;
}
export type WorkspaceAgentResolver = (conversation: string) => WorkspaceAgent;

export function isWorkspaceRoute(path: string): boolean {
  return path === "/api/workspace" || path === "/api/workspace/file" || path === "/api/resources";
}

export function isWorkspaceMutation(request: Request): boolean {
  return new URL(request.url).pathname === "/api/workspace/file" && (request.method === "PUT" || request.method === "DELETE");
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The caller authenticates and enforces token scopes, then resolves this user's assistant. */
export async function handleWorkspaceRequest(request: Request, resolveAgent: WorkspaceAgentResolver): Promise<Response> {
  const url = new URL(request.url);
  const conversation = url.searchParams.get("conversation") ?? "vox";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(conversation) || url.searchParams.getAll("conversation").length > 1) {
    return Response.json({ error: "Invalid conversation" }, { status: 400, headers: PRIVATE });
  }
  if (!isWorkspaceRoute(url.pathname)) return Response.json({ error: "Not found" }, { status: 404, headers: PRIVATE });
  const allowed = url.pathname === "/api/workspace/file" ? "GET, PUT, DELETE" : "GET";
  if (!allowed.split(", ").includes(request.method)) {
    return Response.json({ error: `Use ${allowed}` }, { status: 405, headers: { ...PRIVATE, Allow: allowed } });
  }
  const path = url.searchParams.get("path");
  if (url.pathname === "/api/workspace/file" && (!isWorkspacePath(path) || url.searchParams.getAll("path").length !== 1)) {
    return Response.json({ error: "Provide a relative workspace path up to 256 UTF-8 bytes with no traversal, backslashes, control characters or empty segments" }, { status: 400, headers: PRIVATE });
  }
  const agent = resolveAgent(conversation);
  if (url.pathname === "/api/resources") {
    return Response.json({ conversation, ...JSON.parse(await agent.resourcesSnapshot()) }, { headers: PRIVATE });
  }
  if (url.pathname === "/api/workspace") {
    return Response.json({ conversation, ...await agent.workspaceList() }, { headers: PRIVATE });
  }
  // The preceding route validation establishes a valid, non-null path.
  if (!isWorkspacePath(path)) throw new Error("Workspace route validation failed");
  if (request.method === "GET") {
    const file = await agent.workspaceRead(path);
    return file ? Response.json({ conversation, file }, { headers: PRIVATE })
      : Response.json({ error: "File not found" }, { status: 404, headers: PRIVATE });
  }
  let input: unknown;
  try { input = await readJson(request, 800_000); }
  catch { return Response.json({ error: "Provide a bounded JSON file payload" }, { status: 400, headers: PRIVATE }); }
  if (request.method === "PUT") {
    if (!object(input) || !isWorkspaceContent(input.content)
      || (input.expectedRevision !== null && !isWorkspaceRevision(input.expectedRevision))) {
      return Response.json({ error: `Provide UTF-8 text content up to ${MAX_WORKSPACE_FILE_BYTES} bytes and expectedRevision (null for create; a positive integer for edit)` }, { status: 400, headers: PRIVATE });
    }
    const saved = await agent.workspaceWrite(path, input.content, input.expectedRevision);
    if (!saved.ok) {
      return saved.error === "conflict"
        ? Response.json({ error: "File changed since it was opened", currentRevision: saved.currentRevision }, { status: 409, headers: PRIVATE })
        : Response.json({ error: "Workspace file count or byte limit reached" }, { status: 413, headers: PRIVATE });
    }
    return Response.json({ conversation, file: saved.file }, { status: input.expectedRevision === null ? 201 : 200, headers: PRIVATE });
  }
  if (!object(input) || !isWorkspaceRevision(input.expectedRevision)) {
    return Response.json({ error: "Provide the current expectedRevision to delete a file" }, { status: 400, headers: PRIVATE });
  }
  const deleted = await agent.workspaceDelete(path, input.expectedRevision);
  return deleted.ok ? Response.json({ conversation, deleted: true, path }, { headers: PRIVATE })
    : Response.json({ error: "File changed since it was opened", currentRevision: deleted.currentRevision }, { status: 409, headers: PRIVATE });
}
