import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The board's Vox view: the owner's Vox notebook (~/dev/vox-notebook, kept by the vox-inbox agents-cron task),
 * read from disk and reduced to what the board shows: filed notes, the action checklist, themes and what needs
 * the owner. Only files the notebook already writes are read, nothing is changed.
 *
 * What stays on this machine, as the notebook's own rules ask: `journal/` entries (and actions or review items
 * that point into it), and every note's place and coordinates: the `place:` names are also taken out of all
 * text, since entries mention them in passing. Raw captures in iCloud are never read.
 */

export const NOTE_KINDS = ["ideas", "bugs", "goals", "theories", "history", "misc"] as const;
/** Kept out of the board: personal reflection. */
const PRIVATE_KINDS = new Set(["journal"]);
const BODY_LIMIT = 12_000;
const NOTES_LIMIT = 2_000;
const TEXT_LIMIT = 4_000;

export interface VoxNote {
  /** Path inside the notebook, e.g. `notes/ideas/2026-11-27-vox-custom-vocabulary.md`; the note's id. */
  path: string;
  kind: string;
  title: string;
  /** ISO capture time from the frontmatter, or the date in the file name. */
  captured: string | null;
  /** When the file last changed (entries get dated follow-up sections). */
  updated: string;
  status: string;
  projects: string[];
  /** Issues, PRs and related notes from `links`. */
  links: string[];
  /** The Vox capture it came from (`Vox/2026-11-27-4.md`), as a file name only. */
  source: string | null;
  /** Markdown after the title. */
  body: string;
}

export interface VoxAction {
  project: string;
  text: string;
  done: boolean;
  /** Notes it links to (notebook paths). */
  notes: string[];
}

export interface VoxSection { title: string; body: string }

export interface BoardVox {
  at: string;
  notes: VoxNote[];
  actions: VoxAction[];
  themes: VoxSection[];
  /** INBOX-REVIEW.md's open items, one Markdown block each. */
  review: string[];
  /** The newest run summary (state/last-summary.md, written for Discord, so free of location and journal). */
  lastRun: { at: string; text: string } | null;
  /** Journal entries kept off the board, counted so the totals add up. */
  privateCount: number;
}

/** Reads the notebook, or null when it isn't there. Throws only on unexpected I/O errors. */
export function readNotebook(dir: string, now = new Date()): BoardVox | null {
  if (!isDir(dir)) return null;
  const files: { rel: string; kind: string; text: string; mtime: Date }[] = [];
  const notesDir = path.join(dir, "notes");
  for (const kind of isDir(notesDir) ? readdirSync(notesDir).sort() : []) {
    const kindDir = path.join(notesDir, kind);
    if (!isDir(kindDir)) continue;
    for (const file of readdirSync(kindDir).sort()) {
      if (!file.endsWith(".md") || files.length >= NOTES_LIMIT) continue;
      const full = path.join(kindDir, file);
      files.push({ rel: `notes/${kind}/${file}`, kind, text: readFileSync(full, "utf8"), mtime: statSync(full).mtime });
    }
  }
  const redact = redactor(files.flatMap(f => places(f.text)));
  const privateCount = files.filter(f => PRIVATE_KINDS.has(f.kind)).length;
  const notes = files.filter(f => !PRIVATE_KINDS.has(f.kind)).map(f => parseNote(f.rel, f.kind, f.text, f.mtime, redact));
  notes.sort((a, b) => (b.captured ?? "").localeCompare(a.captured ?? "") || a.path.localeCompare(b.path));
  const known = new Set(notes.map(n => n.path));
  const read = (name: string) => { try { return readFileSync(path.join(dir, name), "utf8"); } catch { return ""; } };
  const summary = path.join(dir, "state", "last-summary.md");
  let lastRun: BoardVox["lastRun"] = null;
  try { lastRun = { at: statSync(summary).mtime.toISOString(), text: clip(redact(readFileSync(summary, "utf8").trim()), TEXT_LIMIT) }; } catch { /* no runs yet */ }
  return {
    at: now.toISOString(),
    notes,
    actions: parseActions(read("ACTIONS.md"), known).map(a => ({ ...a, text: redact(a.text) })),
    themes: sections(read("THEMES.md")).map(s => ({ title: redact(s.title), body: clip(redact(dropPrivateLinks(s.body)), TEXT_LIMIT) })),
    review: openReview(read("INBOX-REVIEW.md")).map(redact),
    lastRun,
    privateCount,
  };
}

export function parseNote(rel: string, kind: string, text: string, mtime: Date, redact: (text: string) => string = t => t): VoxNote {
  const { meta, rest } = frontmatter(text);
  const titleMatch = /^#\s+(.+)$/m.exec(rest);
  const title = titleMatch ? redact(titleMatch[1].trim()) : path.basename(rel, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ");
  const body = titleMatch ? rest.slice((titleMatch.index ?? 0) + titleMatch[0].length) : rest;
  const day = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(rel))?.[1];
  const captured = typeof meta.captured === "string" && !Number.isNaN(Date.parse(meta.captured)) ? new Date(meta.captured).toISOString()
    : day ? `${day}T12:00:00.000Z` : null;
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map(String).filter(Boolean);
  const source = typeof meta.source === "string" ? path.basename(meta.source) : null;
  return {
    path: rel, kind: singular(kind), title, captured, updated: mtime.toISOString(),
    status: typeof meta.status === "string" && meta.status ? meta.status : "open",
    projects: list(meta.projects), links: list(meta.links).filter(l => !/(^|\/)journal\//.test(l)), source,
    body: clip(redact(dropPrivateLinks(body.trim())), BODY_LIMIT),
  };
}

const singular = (kind: string) => ({ ideas: "idea", bugs: "bug", goals: "goal", theories: "theory" } as Record<string, string>)[kind] ?? kind;

/**
 * The small YAML subset the notebook writes: `key: value`, `key: [a, b]`, and `key:` followed by `- item` lines.
 * Comments after `#` are dropped. Keys about location are never kept.
 */
export function frontmatter(text: string): { meta: Record<string, string | string[]>; rest: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, rest: text };
  const meta: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) { (meta[listKey] as string[]).push(unquote(stripComment(item[1]))); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv;
    listKey = null;
    if (/^(place|location|lat|lon|lng|latitude|longitude|coordinates|address)/i.test(key)) continue;
    const v = stripComment(value).trim();
    if (!v) { meta[key] = []; listKey = key; continue; }
    if (v.startsWith("[") && v.endsWith("]")) meta[key] = v.slice(1, -1).split(",").map(s => unquote(s.trim())).filter(Boolean);
    else meta[key] = unquote(v);
  }
  return { meta, rest: text.slice(match[0].length) };
}

const stripComment = (v: string) => v.replace(/\s+#.*$/, "");
const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, "$2");

/** `## Heading` sections (the text before the first one is dropped). */
export function sections(text: string): VoxSection[] {
  const out: VoxSection[] = [];
  let current: VoxSection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { current = { title: h[1].trim(), body: "" }; out.push(current); continue; }
    if (current) current.body += `${line}\n`;
  }
  for (const s of out) s.body = s.body.trim();
  return out;
}

/** ACTIONS.md: `## project` headings over `- [ ]` / `- [x]` items, with the notes each one links. */
export function parseActions(text: string, known: Set<string>): VoxAction[] {
  const out: VoxAction[] = [];
  for (const s of sections(text)) {
    let current: VoxAction | null = null;
    for (const line of s.body.split("\n")) {
      const item = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
      if (item) {
        current = { project: s.title, text: item[2].trim(), done: item[1] !== " ", notes: [] };
        out.push(current);
      } else if (current && /^\s{2,}\S/.test(line)) current.text += ` ${line.trim()}`;
      else current = null;
    }
  }
  // Steps that point into journal/ are personal; they stay on the Mac with it.
  const shared = out.filter(a => !PRIVATE_LINK.test(a.text));
  for (const a of shared) {
    a.notes = [...a.text.matchAll(/\]\((notes\/[^)\s]+\.md)\)/g)].map(m => m[1]).filter(p => known.has(p));
    a.text = clip(a.text, TEXT_LIMIT);
  }
  return shared;
}

/** A Markdown link into journal/. */
const PRIVATE_LINK = /\]\((?:\.\.\/)*(?:notes\/)?journal\//;

/** The `place:` values in a note's frontmatter. */
export function places(text: string): string[] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return [...fm.matchAll(/^(?:place|location):\s*(.+)$/gim)].map(m => unquote(stripComment(m[1]).trim())).filter(p => p.length >= 3);
}

/**
 * Takes the given place names out of text (whole words, any case), with the comma or bracket around them,
 * so "(`2026-11-25.md`, Rincón)" becomes "(`2026-11-25.md`)".
 */
export function redactor(names: string[]): (text: string) => string {
  const unique = [...new Set(names.map(n => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return text => text;
  const escaped = unique.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?:\\s*[,;·]\\s*|\\s+)?(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return text => {
    if (!pattern.test(text)) return text;
    pattern.lastIndex = 0;
    return text.replace(pattern, "")
      .replace(/\(\s*[,;·]\s*/g, "(").replace(/\(\s*\)/g, "")
      .replace(/(\S) {2,}/g, "$1 ").replace(/ +([,.;:)])/g, "$1").replace(/^ +(?=\S)/, "");
  };
}

/** INBOX-REVIEW.md's `## Open` section, split into its top-level bullets (without those about journal entries). */
export function openReview(text: string): string[] {
  const open = sections(text).find(s => /^open$/i.test(s.title));
  if (!open) return [];
  const items: string[] = [];
  for (const line of open.body.split("\n")) {
    if (/^[-*]\s+/.test(line)) items.push(line.replace(/^[-*]\s+/, ""));
    // Blank lines stay inside an item (a list, then a closing question); the next top-level bullet ends it.
    else if (items.length) items[items.length - 1] += `\n${line.replace(/^ {2}/, "")}`;
  }
  return items.map(i => i.trim()).filter(i => i && !PRIVATE_LINK.test(i)).map(i => clip(i, TEXT_LIMIT));
}

/** Links into journal/ would point at notes the board doesn't have; keep their text only. */
function dropPrivateLinks(md: string): string {
  return md.replace(/\[([^\]]*)\]\((?:\.\.\/)*(?:notes\/)?journal\/[^)]*\)/g, "$1");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
