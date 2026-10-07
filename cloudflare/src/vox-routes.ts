import type { Bindings } from "./index.js";
import { readJson } from "./http-body.js";
import { isVoxId, parseVoxCapture } from "./vox.js";

const PRIVATE = { "Cache-Control": "no-store" };

export function isCaptureRoute(path: string): boolean {
  return path === "/api/vox" || path === "/api/notes" || path.startsWith("/api/notes/");
}

/** Vox only consumes the receipt; Pi responses and originals have their own URLs. */
export async function handleCaptureRequest(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  const conversation = url.searchParams.get("conversation") ?? "vox";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(conversation) || url.searchParams.getAll("conversation").length > 1) {
    return Response.json({ error: "Invalid conversation" }, { status: 400, headers: PRIVATE });
  }
  if (url.pathname === "/api/vox") {
    if (request.method !== "POST") {
      return Response.json({ error: "Use POST with Vox JSON" }, { status: 405, headers: { ...PRIVATE, Allow: "POST" } });
    }
    const mode = url.searchParams.get("mode") ?? "memory";
    if ((mode !== "prompt" && mode !== "memory") || url.searchParams.getAll("mode").length > 1) {
      return Response.json({ error: "mode must be prompt or memory" }, { status: 400, headers: PRIVATE });
    }
    const parsed = parseVoxCapture(await readJson(request, 1_048_576), request.headers.get("Idempotency-Key"), mode);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: PRIVATE });
    if (parsed.test) return Response.json({ ok: true, test: true, mode, conversation }, { headers: PRIVATE });
    const saved = await env.Assistant.getByName(`http:${conversation}`).storeCapture({
      id: parsed.input.id, mode: parsed.input.mode, markdown: parsed.input.markdown,
      payloadJson: JSON.stringify(parsed.input.payload),
    });
    if (saved.conflict) {
      return Response.json({ error: "Capture id was already used with different content or mode" }, { status: 409, headers: PRIVATE });
    }
    const { note, duplicate } = saved;
    const noteUrl = new URL(`/api/notes/${note.id}`, url.origin);
    noteUrl.searchParams.set("conversation", conversation);
    const markdownUrl = new URL(`/api/notes/${note.id}.md`, url.origin);
    markdownUrl.searchParams.set("conversation", conversation);
    return Response.json({
      id: note.id, mode: note.mode, conversation, duplicate,
      status: note.mode === "memory" ? "stored" : note.result?.status ?? "queued",
      ...(note.mode === "prompt" ? { operationId: `vox:${note.id}` } : {}),
      noteUrl: noteUrl.href, markdownUrl: markdownUrl.href,
    }, { status: note.mode === "prompt" ? 202 : duplicate ? 200 : 201, headers: PRIVATE });
  }
  if (request.method !== "GET") {
    return Response.json({ error: "Use GET to retrieve notes" }, { status: 405, headers: { ...PRIVATE, Allow: "GET" } });
  }
  if (url.pathname === "/api/notes") {
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const beforeValue = url.searchParams.get("before");
    const before = beforeValue === null ? undefined : Number(beforeValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100
      || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) {
      return Response.json({ error: "limit must be 1–100; before must be a positive integer cursor" }, { status: 400, headers: PRIVATE });
    }
    const notes = await env.Assistant.getByName(`http:${conversation}`).listCaptures({ limit, before });
    return Response.json({ conversation, ...notes }, { headers: PRIVATE });
  }
  const match = url.pathname.match(/^\/api\/notes\/([^/]+?)(\.md|\/source\.json|\/response\.md)?$/);
  if (!match || !isVoxId(match[1])) return Response.json({ error: "Not found" }, { status: 404, headers: PRIVATE });
  const id = match[1].toLowerCase();
  const suffix = match[2];
  const agent = env.Assistant.getByName(`http:${conversation}`);
  if (suffix === ".md" || suffix === "/source.json") {
    const note = await agent.archivedNote(id);
    if (!note) return Response.json({ error: "Note not found" }, { status: 404, headers: PRIVATE });
    if (suffix === "/source.json") return new Response(note.payloadJson, { headers: { ...PRIVATE, "Content-Type": "application/json; charset=utf-8" } });
    return markdown(note.markdown, `${id}.md`);
  }
  const note = await agent.captureStatus(id);
  if (!note) return Response.json({ error: "Note not found" }, { status: 404, headers: PRIVATE });
  if (suffix === "/response.md") {
    if (note.mode === "memory") return Response.json({ error: "Memory captures do not run Pi" }, { status: 404, headers: PRIVATE });
    if (!note.result) return Response.json({ id, status: note.status }, { status: 202, headers: PRIVATE });
    if (note.result.status === "unanswered") {
      return Response.json({ id, status: "unanswered", reason: note.result.reason }, { status: 422, headers: PRIVATE });
    }
    return markdown(note.result.text, `${id}.response.md`);
  }
  const { payloadJson, ...fields } = note;
  return Response.json({ conversation, ...fields, payload: JSON.parse(payloadJson) }, { headers: PRIVATE });
}

function markdown(content: string, filename: string): Response {
  return new Response(content, { headers: {
    ...PRIVATE, "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  } });
}
