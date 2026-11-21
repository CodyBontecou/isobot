import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Google APIs with a service account key (a JSON key file from Google Cloud), for the ASO train's Play listings
 * (Android Publisher) and Play Console's bulk reports (Cloud Storage). The key file stays on disk; only its
 * path is in the config, and the private key never leaves this process.
 */

export const PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
export const STORAGE_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>;
}>;

interface ServiceAccountKey { client_email: string; private_key: string; token_uri?: string }

/** A Google API's refusal, with its HTTP status and Google's own message. */
export class GoogleApiError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string) {
    super(message);
  }
}

/** Google's error JSON → a readable message (and the first error reason, like "forbidden"). */
export function googleError(status: number, body: string): GoogleApiError {
  try {
    const e = (JSON.parse(body) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } | string; error_description?: string });
    if (typeof e.error === "string") return new GoogleApiError(status, `${e.error}${e.error_description ? `: ${e.error_description}` : ""}`, e.error);
    if (e.error?.message) return new GoogleApiError(status, e.error.message, e.error.errors?.[0]?.reason ?? e.error.status);
  } catch { /* not JSON */ }
  return new GoogleApiError(status, `HTTP ${status}${body.trim() ? `: ${body.trim().slice(0, 200)}` : ""}`);
}

/** Access tokens for one service account, one per scope, refreshed a few minutes before they expire. */
export class GoogleAuth {
  private tokens = new Map<string, { token: string; until: number }>();
  private key: ServiceAccountKey | null = null;

  constructor(private keyPath: string, private fetchFn: Fetch = fetch as unknown as Fetch, private now: () => number = Date.now) {}

  /** The service account's email (for messages), or null when the key can't be read. */
  email(): string | null {
    try { return this.load().client_email; } catch { return null; }
  }

  private load(): ServiceAccountKey {
    if (this.key) return this.key;
    let raw: string;
    try {
      raw = readFileSync(this.keyPath, "utf8");
    } catch {
      throw new Error(`the Google service account key isn't at ${this.keyPath}`);
    }
    const key = JSON.parse(raw) as Partial<ServiceAccountKey>;
    if (!key.client_email || !key.private_key) throw new Error(`${this.keyPath} isn't a service account key (no client_email/private_key)`);
    this.key = key as ServiceAccountKey;
    return this.key;
  }

  async token(scope: string): Promise<string> {
    const cached = this.tokens.get(scope);
    if (cached && cached.until > this.now()) return cached.token;
    const key = this.load();
    const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(this.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: key.client_email, scope, aud: tokenUri, iat, exp: iat + 3600 })}`;
    const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url")}`;
    const res = await this.fetchFn(tokenUri, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
    });
    const body = await res.text();
    if (!res.ok) throw googleError(res.status, body);
    const json = JSON.parse(body) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Google's token endpoint returned no access token");
    this.tokens.set(scope, { token: json.access_token, until: this.now() + Math.max(60, (json.expires_in ?? 3600) - 300) * 1000 });
    return json.access_token;
  }

  /** An authorized request; non-2xx throws a GoogleApiError. Returns the parsed JSON (or null for an empty body). */
  async json(scope: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const res = await this.fetchFn(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${await this.token(scope)}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw googleError(res.status, text);
    return text.trim() ? JSON.parse(text) : null;
  }

  async bytes(scope: string, url: string): Promise<Buffer> {
    const res = await this.fetchFn(url, { headers: { authorization: `Bearer ${await this.token(scope)}` } });
    if (!res.ok) throw googleError(res.status, await res.text());
    return Buffer.from(await res.arrayBuffer());
  }
}

/** A Play store listing for one language: the three indexed text fields. */
export interface PlayListing { title: string; shortDescription: string; fullDescription: string }

export const PLAY_FIELDS = ["title", "shortDescription", "fullDescription"] as const;
export type PlayField = typeof PLAY_FIELDS[number];

/** Play Console's limits, in characters. */
export const PLAY_LIMITS: Record<PlayField, number> = { title: 30, shortDescription: 80, fullDescription: 4000 };

/** The result of committing a listing edit. */
export interface PlayCommit {
  /** Commit went through with changesNotSentForReview: saved in Play Console, waiting to be sent for review there. */
  notSentForReview: boolean;
}

/** Store listings through the Android Publisher API's edits: read without committing, write one language's fields. */
export class PlayPublisher {
  constructor(private auth: GoogleAuth) {}

  private base(pkg: string) { return `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}`; }

  /** Every language's listing, read inside a throwaway edit (deleted afterwards, never committed). */
  async listings(pkg: string): Promise<Record<string, PlayListing>> {
    const edit = await this.auth.json(PUBLISHER_SCOPE, `${this.base(pkg)}/edits`, { method: "POST", body: {} }) as { id?: string };
    if (!edit?.id) throw new Error(`Play gave no edit id for ${pkg}`);
    try {
      const r = await this.auth.json(PUBLISHER_SCOPE, `${this.base(pkg)}/edits/${edit.id}/listings`) as { listings?: Record<string, unknown>[] } | null;
      const out: Record<string, PlayListing> = {};
      for (const l of r?.listings ?? []) {
        const s = (k: string) => typeof l[k] === "string" ? l[k] as string : "";
        if (s("language")) out[s("language")] = { title: s("title"), shortDescription: s("shortDescription"), fullDescription: s("fullDescription") };
      }
      return out;
    } finally {
      await this.auth.json(PUBLISHER_SCOPE, `${this.base(pkg)}/edits/${edit.id}`, { method: "DELETE" }).catch(() => undefined);
    }
  }

  /**
   * Patches these fields of one language's listing and commits. An app under managed publishing refuses a
   * plain commit; then it commits with changesNotSentForReview (the change waits in Play Console to be sent).
   * A failed edit is deleted, so nothing half-written is left behind.
   */
  async update(pkg: string, language: string, fields: Partial<PlayListing>): Promise<PlayCommit> {
    const edit = await this.auth.json(PUBLISHER_SCOPE, `${this.base(pkg)}/edits`, { method: "POST", body: {} }) as { id?: string };
    if (!edit?.id) throw new Error(`Play gave no edit id for ${pkg}`);
    const editUrl = `${this.base(pkg)}/edits/${edit.id}`;
    let committed = false;
    try {
      await this.auth.json(PUBLISHER_SCOPE, `${editUrl}/listings/${encodeURIComponent(language)}`, { method: "PATCH", body: { language, ...fields } });
      try {
        await this.auth.json(PUBLISHER_SCOPE, `${editUrl}:commit`, { method: "POST" });
        committed = true;
        return { notSentForReview: false };
      } catch (error) {
        if (!(error instanceof GoogleApiError) || !/changesNotSentForReview/i.test(error.message)) throw error;
        await this.auth.json(PUBLISHER_SCOPE, `${editUrl}:commit?changesNotSentForReview=true`, { method: "POST" });
        committed = true;
        return { notSentForReview: true };
      }
    } finally {
      if (!committed) await this.auth.json(PUBLISHER_SCOPE, editUrl, { method: "DELETE" }).catch(() => undefined);
    }
  }
}

/** Objects in a Cloud Storage bucket under a prefix (name, generation, updated), every page. */
export async function listObjects(auth: GoogleAuth, bucket: string, prefix: string): Promise<{ name: string; generation: string; updated: string }[]> {
  const out: { name: string; generation: string; updated: string }[] = [];
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}&maxResults=1000&fields=items(name,generation,updated),nextPageToken${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const r = await auth.json(STORAGE_SCOPE, url) as { items?: { name: string; generation: string; updated: string }[]; nextPageToken?: string } | null;
    out.push(...(r?.items ?? []));
    if (!r?.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return out;
}

export function objectUrl(bucket: string, name: string): string {
  return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`;
}
