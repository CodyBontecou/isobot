export type VoxMode = "prompt" | "memory";

export interface VoxCapture {
  id: string;
  mode: VoxMode;
  markdown: string;
  payload: Record<string, unknown>;
}

export type VoxParseResult =
  | { ok: false; error: string }
  | { ok: true; test: boolean; input: VoxCapture };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MARKDOWN_BYTES = 1_048_576;
const MAX_PROMPT_CHARACTERS = 64_000;
const APPLE_EPOCH_SECONDS = 978_307_200;
const encoder = new TextEncoder();

export function isVoxId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isISODate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59));
}

/** Select the preset-produced instructions while keeping the raw capture intact. */
export function voxPrompt(input: Pick<VoxCapture, "markdown" | "payload">): string {
  const cleaned = input.payload.cleanedText;
  return typeof cleaned === "string" && cleaned.trim() ? cleaned : input.markdown;
}

/** Accept both current Capture JSON and legacy Transcript JSON from Vox.md. */
export function parseVoxCapture(value: unknown, idempotencyKey: string | null, mode: VoxMode): VoxParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Send a Vox.md JSON object." };
  }
  const payload = value as Record<string, unknown>;
  if (!isVoxId(idempotencyKey)) {
    return { ok: false, error: "Idempotency-Key must contain the capture UUID." };
  }
  if (!isVoxId(payload.id) || payload.id.toLowerCase() !== idempotencyKey.toLowerCase()) {
    return { ok: false, error: "id must be a UUID matching Idempotency-Key." };
  }
  if (typeof payload.text !== "string" || !payload.text.trim()) {
    return { ok: false, error: "text must contain nonblank Markdown." };
  }
  if (encoder.encode(payload.text).byteLength > MAX_MARKDOWN_BYTES) {
    return { ok: false, error: "text must be at most 1 MiB of UTF-8 Markdown." };
  }
  if ("cleanedText" in payload && (typeof payload.cleanedText !== "string"
    || encoder.encode(payload.cleanedText).byteLength > MAX_MARKDOWN_BYTES)) {
    return { ok: false, error: "cleanedText must be a string of at most 1 MiB in UTF-8." };
  }
  if ("test" in payload && typeof payload.test !== "boolean") {
    return { ok: false, error: "test must be a boolean." };
  }
  if ("recorded_at" in payload && (typeof payload.recorded_at !== "string" || !isISODate(payload.recorded_at))) {
    return { ok: false, error: "recorded_at must be an ISO 8601 timestamp." };
  }
  if ("date" in payload && (typeof payload.date !== "number" || !Number.isFinite(payload.date))) {
    return { ok: false, error: "date must be finite seconds since Apple's 2001 epoch." };
  }
  if ("duration" in payload && (typeof payload.duration !== "number" || !Number.isFinite(payload.duration) || payload.duration < 0)) {
    return { ok: false, error: "duration must be a finite nonnegative number." };
  }
  for (const field of ["source", "modelUsed", "language", "title"]) {
    if (field in payload && typeof payload[field] !== "string") {
      return { ok: false, error: `${field} must be a string.` };
    }
  }
  const input: VoxCapture = { id: payload.id.toLowerCase(), mode, markdown: payload.text, payload };
  if (mode === "prompt" && voxPrompt(input).length > MAX_PROMPT_CHARACTERS) {
    return { ok: false, error: "Pi instructions must be at most 64,000 characters. Use memory mode to store a larger capture." };
  }
  return { ok: true, test: payload.test === true, input };
}

/** Derive an index timestamp without changing the original Vox payload. */
export function recordedAt(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.recorded_at === "string" && isISODate(payload.recorded_at)) return payload.recorded_at;
  if (typeof payload.date !== "number" || !Number.isFinite(payload.date)) return undefined;
  const date = new Date((payload.date + APPLE_EPOCH_SECONDS) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
