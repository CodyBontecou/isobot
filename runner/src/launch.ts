import path from "node:path";

/**
 * User-facing release notes and the launch post for a version once it's live on the App Store.
 *
 * The notes are written once, when the train announces a version: the ship issue shows them
 * during the hold, the App Store gets `whatsNew`, and the app's Discord launch channel gets the rest
 * once Apple has the version on sale.
 */

export type ChangeKind = "new" | "fixed" | "improved";

export interface ReleaseNotes {
  /** One line for the top of the launch post. */
  headline: string;
  /** What users will notice, in plain language. Internal-only changes are left out. */
  items: { kind: ChangeKind; text: string }[];
  /** The App Store's What's New text (plain text, at most 4000 characters). */
  whatsNew: string;
}

export interface ReleaseChange {
  number: number;
  title: string;
  /** The merged PR's description, for context; written by the builder, so untrusted. */
  summary: string;
}

export interface ReleaseNotesInput {
  app: string;
  version: string;
  changes: ReleaseChange[];
}

const KINDS: Record<ChangeKind, string> = { new: "✨ **New**", fixed: "🐛 **Fixed**", improved: "💅 **Improved**" };
const GENERIC = "Bug fixes and improvements.";

/** Notes from the job titles alone, for when the model is unavailable. */
export function fallbackNotes(jobs: { title: string }[]): ReleaseNotes {
  const lines = jobs.map(job => `• ${oneLine(job.title)}`);
  return {
    headline: "",
    items: jobs.map(job => ({ kind: "improved", text: oneLine(job.title) })),
    whatsNew: `Fixes and improvements in this update:\n${lines.join("\n")}`.slice(0, 3900),
  };
}

/**
 * Model output goes out in public, so it's cleaned: one line per item, no links or mentions,
 * bounded lengths, and a usable What's New even if the model gave none.
 */
export function cleanNotes(value: unknown): ReleaseNotes {
  const v = (value ?? {}) as Partial<ReleaseNotes>;
  const items = (Array.isArray(v.items) ? v.items : [])
    .map(item => ({
      kind: (["new", "fixed", "improved"] as const).find(k => k === item?.kind) ?? "improved",
      text: scrub(oneLine(String(item?.text ?? ""))).slice(0, 300),
    }))
    .filter(item => item.text)
    .slice(0, 20);
  const whatsNew = scrub(String(v.whatsNew ?? "")).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 3900);
  return {
    headline: scrub(oneLine(String(v.headline ?? ""))).slice(0, 200),
    items,
    whatsNew: whatsNew || (items.length ? items.map(item => `• ${item.text}`).join("\n").slice(0, 3900) : GENERIC),
  };
}

/** Discord truncates longer messages (notify.ts message()), which would cut off the App Store link. */
export const LAUNCH_MAX_CHARS = 1900;

/** The Discord launch post, kept under LAUNCH_MAX_CHARS by leaving out the last items rather than the link. */
export function launchMessage(app: string, version: string, notes: ReleaseNotes, storeUrl: string, beta?: { joinUrl?: string }): string {
  const title = beta ? `# 🧪 ${app} ${version} beta is on TestFlight` : `# 🎉 ${app} ${version} is out`;
  const link = !beta ? `📲 Update on the App Store: <${storeUrl}>`
    : beta.joinUrl ? `🧪 Join the beta on TestFlight: <${beta.joinUrl}>` : "🧪 Testers: update in the TestFlight app.";
  const join = (parts: string[]) => parts.filter(Boolean).join("\n\n");
  const render = (items: ReleaseNotes["items"], more: number) => {
    const sections = (Object.keys(KINDS) as ChangeKind[]).flatMap(kind => {
      const lines = items.filter(item => item.kind === kind).map(item => `• ${item.text}`);
      return lines.length ? [`${KINDS[kind]}\n${lines.join("\n")}`] : [];
    });
    return join([title, notes.headline, sections.length ? sections.join("\n\n") : notes.whatsNew, more ? `…and ${more} more` : "", link]);
  };
  for (let n = notes.items.length; n > 0; n--) {
    const message = render(notes.items.slice(0, n), notes.items.length - n);
    if (message.length <= LAUNCH_MAX_CHARS) return message;
  }
  // No item fits (or there are none): What's New, shortened to leave room for the link.
  const room = LAUNCH_MAX_CHARS - join([title, notes.headline, "", link]).length - 3;
  const whatsNew = notes.whatsNew.length > room ? `${notes.whatsNew.slice(0, Math.max(0, room - 1)).trimEnd()}…` : notes.whatsNew;
  return join([title, notes.headline, whatsNew, link]);
}

export interface MediaRef {
  ref: string;
  path: string;
  name: string;
  kind: "image" | "video";
}

/**
 * Captures a PR body links from the isobot/media branch (media.ts mediaMarkdown), images first.
 * Only links into this repository's own media commits count.
 */
export function mediaRefs(body: string, owner: string, repo: string): MediaRef[] {
  const base = `https://github.com/${owner}/${repo}/blob/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${base}([0-9a-f]{40})/([\\w./-]+?)\\?raw=true`, "gi");
  const seen = new Set<string>();
  const refs: MediaRef[] = [];
  for (const match of body.matchAll(pattern)) {
    const [, ref, file] = match;
    if (file.split("/").includes("..") || seen.has(file)) continue;
    seen.add(file);
    const ext = path.extname(file).toLowerCase();
    const kind = [".mp4", ".mov", ".m4v"].includes(ext) ? "video" : [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext) ? "image" : null;
    if (kind) refs.push({ ref, path: file, name: path.basename(file), kind });
  }
  return refs.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "image" ? -1 : 1));
}

/** For the model: a PR description without the markup and media links that only matter on GitHub. */
export function summaryText(body: string): string {
  return body
    .replace(/<img[^>]*>/gi, "")
    .replace(/https:\/\/github\.com\/[^\s)"]+\?raw=true/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2000);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** No links, no mentions, no markdown headings: the post is the runner's words, not the model's. */
function scrub(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/<[@#&!][^>]*>/g, "")
    .replace(/@(everyone|here)\b/gi, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
