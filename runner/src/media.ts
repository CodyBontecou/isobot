import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";

/**
 * Screenshots and recordings the builder saved to $ISOBOT_MEDIA to show a visible change.
 * The runner publishes them in the PR body (via the isobot/media branch, git.ts) and the job's
 * Discord thread. They come from builder-controlled code, so only plain files whose bytes
 * really are an image or video, within size limits, are taken.
 */
export interface MediaFile {
  file: string;
  name: string;
  kind: "image" | "video";
  bytes: number;
  caption: string;
}

export const MAX_MEDIA_FILES = 8;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
/** Discord's upload limit for bots without a boosted server. */
export const DISCORD_MAX_BYTES = 10 * 1024 * 1024;

const SIGNATURES: { ext: string[]; kind: MediaFile["kind"]; test: (head: Buffer) => boolean }[] = [
  { ext: [".png"], kind: "image", test: h => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: [".jpg", ".jpeg"], kind: "image", test: h => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  { ext: [".gif"], kind: "image", test: h => h.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: [".webp"], kind: "image", test: h => h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP" },
  // MP4 and QuickTime: an ISO base media box, "ftyp" at offset 4 (simctl and screenrecord both write this).
  { ext: [".mp4", ".mov", ".m4v"], kind: "video", test: h => ["ftyp", "moov", "mdat", "wide"].includes(h.subarray(4, 8).toString("latin1")) },
];

/** "02-after-export-sheet.png" → "After export sheet". */
export function captionFor(name: string): string {
  const words = path.parse(name).name.replace(/^\d+[-_ .]*/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

function head(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(16);
    readSync(fd, buffer, 0, 16, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/** Valid media in `dir`, sorted by name, plus a note for each file left out. */
export function collectMedia(dir: string): { files: MediaFile[]; skipped: string[] } {
  const files: MediaFile[] = [];
  const skipped: string[] = [];
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return { files, skipped }; }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const file = path.join(dir, name);
    const stat = lstatSync(file);
    // Symlinks could point the runner at anything on disk; only regular files count.
    if (!stat.isFile()) { skipped.push(`${name}: not a regular file`); continue; }
    const signature = SIGNATURES.find(s => s.ext.includes(path.extname(name).toLowerCase()));
    if (!signature) { skipped.push(`${name}: not a PNG, JPEG, GIF, WebP, MP4 or MOV`); continue; }
    if (!signature.test(head(file))) { skipped.push(`${name}: contents don't match its extension`); continue; }
    const limit = signature.kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (stat.size > limit) { skipped.push(`${name}: ${mb(stat.size)} is over the ${mb(limit)} limit`); continue; }
    if (files.length >= MAX_MEDIA_FILES) { skipped.push(`${name}: more than ${MAX_MEDIA_FILES} files`); continue; }
    // Published names are safe for URLs and git paths whatever the builder called the file.
    const safe = name.replace(/[^\w.-]+/g, "-");
    files.push({ file, name: safe, kind: signature.kind, bytes: stat.size, caption: captionFor(name) });
  }
  return { files, skipped };
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The PR body section: images inline, videos as links (GitHub only embeds its own uploads). */
export function mediaMarkdown(files: MediaFile[], urls: Record<string, string>): string {
  return files.filter(f => urls[f.name]).map(f => f.kind === "image"
    ? `**${f.caption}**\n\n<img src="${urls[f.name]}" alt="${f.caption.replaceAll("\"", "'")}" width="320">`
    : `🎬 [${f.caption}](${urls[f.name]}) (video, ${mb(f.bytes)})`).join("\n\n");
}
