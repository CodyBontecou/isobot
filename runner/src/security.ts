import { createHash } from "node:crypto";
import { configuredRepos, policyFor, type RunnerConfig, type SecurityLimits } from "./config.js";
import type { AgentJsonInput } from "./builder.js";
import { localDay } from "./content.js";
import type { GitHubApi, SecretAlert } from "./github.js";
import type { RunResult } from "./proc.js";
import type { Store } from "./store.js";

/**
 * The security audit: every night, each repository isobot builds gets
 *
 *   - a dependency scan (osv-scanner over every lockfile: npm, Cargo, RubyGems, Go, Python, Swift…), with one issue
 *     per lockfile that carries a high or critical advisory, listing the versions that fix it
 *   - GitHub's own secret-scanning alerts: a leaked credential needs the owner to revoke it, which no code change does,
 *     so it is a check-in flag until the alert is closed
 *   - a read-only review by an agent: the whole repository once every `fullEveryDays` (one repository a night, so they
 *     take turns), otherwise only the commits since the last audit. gitleaks' hits and the scanners' output go in as
 *     unverified hints; the agent reports only what it can tie to a concrete attack
 *
 * Each finding at or above `minSeverity` becomes one GitHub issue labelled `security`, approved straight away with
 * `autoApprove` (isobot:ready + isobot:auto) so isobot builds, reviews, merges and ships the fix. Fixes that touch
 * protected paths (auth, payments, entitlements, CI) still wait for the owner's review, as any build does.
 *
 * Most of isobot's repositories are public, and a public issue that describes an unfixed hole is a disclosure. On a
 * public repository a code finding's issue says only where and how bad; the details (what's wrong, how it's
 * exploited, the fix) are kept in the runner's store and handed to the builder privately (pipeline.ts). Dependency
 * advisories are public already, so their issues are complete.
 */

const AGENT_TIMEOUT_MS = 45 * 60_000;
const SCANNER_TIMEOUT_MS = 15 * 60_000;
/** The marker on issues the audit opens (dashboard.ts and pipeline.ts read it). */
export const SECURITY_MARKER = "<!-- isobot:security:";
const MARKER_RE = /<!-- isobot:security:(dep|code):([0-9a-f]{12,})(?::[0-9a-f]+)? -->/;
export const securityDetailKey = (id: string) => `security:detail:${id}`;

export type Severity = "critical" | "high" | "medium" | "low";
const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const atLeast = (s: Severity, min: Severity) => RANK[s] >= RANK[min];
const hash = (s: string, n = 16) => createHash("sha256").update(s).digest("hex").slice(0, n);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A CVSS score (osv-scanner's group max_severity) as a severity; unscored advisories are "low". */
export function cvssSeverity(score: string | number | undefined): Severity {
  const x = Number(score);
  if (!Number.isFinite(x) || x <= 0) return "low";
  return x >= 9 ? "critical" : x >= 7 ? "high" : x >= 4 ? "medium" : "low";
}

export interface DependencyAdvisory { id: string; severity: Severity; summary: string; fixed: string | null }
export interface VulnerablePackage { ecosystem: string; name: string; version: string; advisories: DependencyAdvisory[] }
/** One lockfile's vulnerable packages. */
export interface LockfileReport { path: string; packages: VulnerablePackage[]; severity: Severity }

/** Lockfiles that aren't the repository's own dependencies: vendored crates, fixtures, checked-in node_modules. */
const IGNORED_PATH = /(^|\/)(vendor|vendored|third_party|node_modules|fixtures?|testdata|__fixtures__|Pods|\.build|DerivedData)\//i;

interface OsvJson {
  results?: {
    source?: { path?: string };
    packages?: {
      package?: { name?: string; version?: string; ecosystem?: string };
      vulnerabilities?: { id: string; aliases?: string[]; summary?: string; affected?: { package?: { name?: string }; ranges?: { events?: { fixed?: string }[] }[] }[] }[];
      groups?: { ids?: string[]; max_severity?: string }[];
    }[];
  }[];
}

/** Compares dotted versions loosely (numbers numerically, anything else as text). */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.+-]/), pb = b.replace(/^v/, "").split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0", y = pb[i] ?? "0";
    const nx = Number(x), ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}

/** osv-scanner's JSON → vulnerable packages by lockfile (paths relative to `root`), worst first. */
export function parseOsv(json: OsvJson, root: string): LockfileReport[] {
  const out: LockfileReport[] = [];
  const prefix = root.endsWith("/") ? root : `${root}/`;
  for (const r of json.results ?? []) {
    const file = (r.source?.path ?? "").replace(prefix, "").replace(/^\/+/, "");
    if (!file || IGNORED_PATH.test(file)) continue;
    const packages: VulnerablePackage[] = [];
    for (const p of r.packages ?? []) {
      const name = p.package?.name ?? "?";
      const version = p.package?.version ?? "?";
      const vulns = new Map((p.vulnerabilities ?? []).map(v => [v.id, v]));
      const advisories: DependencyAdvisory[] = [];
      for (const g of p.groups ?? []) {
        const ids = g.ids ?? [];
        if (!ids.length) continue;
        const members = ids.map(id => vulns.get(id)).filter(v => v !== undefined);
        const id = ids.find(i => i.startsWith("GHSA-")) ?? ids.find(i => i.startsWith("CVE-")) ?? ids[0];
        const fixes = members.flatMap(v => (v.affected ?? []).filter(a => !a.package?.name || a.package.name === name)
          .flatMap(a => (a.ranges ?? []).flatMap(x => (x.events ?? []).map(e => e.fixed).filter((f): f is string => Boolean(f)))))
          .filter(f => compareVersions(f, version) > 0).sort(compareVersions);
        advisories.push({ id, severity: cvssSeverity(g.max_severity), summary: (members.find(m => m.summary)?.summary ?? "").slice(0, 160), fixed: fixes[0] ?? null });
      }
      if (advisories.length) {
        advisories.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
        packages.push({ ecosystem: p.package?.ecosystem ?? "?", name, version, advisories });
      }
    }
    if (!packages.length) continue;
    packages.sort((a, b) => RANK[b.advisories[0].severity] - RANK[a.advisories[0].severity] || a.name.localeCompare(b.name));
    out.push({ path: file, packages, severity: packages[0].advisories[0].severity });
  }
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.path.localeCompare(b.path));
}

/** A gitleaks hit, already redacted (gitleaks runs with --redact): rule, file and line only. */
export interface LeakHint { rule: string; file: string; line: number }
const CODE_FILE = /\.(py|rb|js|mjs|cjs|ts|tsx|jsx|swift|kt|kts|java|go|rs|sh|zsh|bash|plist|xcconfig|gradle|properties|ya?ml|toml|env)$|(^|\/)\.env[^/]*$/i;
const NOISY_PATH = /(^|\/)(test|tests|androidTest|e2e|__tests__|spec|artifacts|docs|release-drafts|screenshots?\/.*\.(json|html))\//i;

/**
 * gitleaks' findings worth an agent's look. Its generic-api-key rule fires on hashes, signatures and sample data
 * all over these repositories, so those count only in source and config files outside tests and docs; the
 * provider-specific rules (a private key, a Stripe key) always count.
 */
export function leakHints(json: unknown, max = 40): LeakHint[] {
  const rows = Array.isArray(json) ? json as { RuleID?: string; File?: string; StartLine?: number }[] : [];
  const seen = new Set<string>();
  const out: LeakHint[] = [];
  for (const r of rows) {
    const rule = r.RuleID ?? "?", file = r.File ?? "";
    if (!file || IGNORED_PATH.test(file)) continue;
    if (rule === "generic-api-key" && (!CODE_FILE.test(file) || NOISY_PATH.test(file))) continue;
    const key = `${rule}|${file}|${r.StartLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rule, file, line: r.StartLine ?? 0 });
  }
  // Specific rules first: they're rarely wrong.
  return out.sort((a, b) => Number(a.rule === "generic-api-key") - Number(b.rule === "generic-api-key")).slice(0, max);
}

/** One finding of the agent's review. `detail` and `fix` are private on a public repository. */
export interface CodeFinding {
  title: string;
  publicTitle: string;
  severity: Severity;
  category: string;
  files: string[];
  detail: string;
  fix: string;
  confidence: number;
  /** What only the owner can do (revoke a key, change an account setting); empty when a code change is the fix. */
  ownerAction: string;
}

export const AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string", description: "One or two sentences: what you reviewed and the overall state." },
    findings: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "publicTitle", "severity", "category", "files", "detail", "fix", "confidence", "ownerAction"],
        properties: {
          title: { type: "string", description: "Specific title, e.g. 'Webhook accepts unsigned requests in worker/src/stripe.ts'." },
          publicTitle: { type: "string", description: "A title safe on a public issue before the fix ships: the component and the kind of hardening, no attack, e.g. 'Harden webhook request validation in the pricing worker'." },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          category: { type: "string", description: "Short kebab-case, e.g. hardcoded-secret, auth-bypass, injection, path-traversal, ssrf, insecure-storage, tls, webview, exported-component, ci-injection, cors, data-exposure." },
          files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "Repository-relative paths, the most important first; add :line where it helps." },
          detail: { type: "string", description: "What is wrong, who can exploit it and how, and what they gain. Never quote a secret's value." },
          fix: { type: "string", description: "The change that fixes it, concrete enough to build, and a test that would have caught it." },
          confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are it's real and exploitable as described." },
          ownerAction: { type: "string", description: "What only the owner can do (revoke and rotate a leaked key, change a store or cloud setting, purge git history); empty string when the code change is the whole fix." },
        },
      },
    },
  },
} as const;

export function auditRules(repo: string, isPublic: boolean, notes?: string): string {
  return [
    `You are a senior application-security reviewer auditing ${repo}, one of a solo developer's shipping apps (iOS/macOS apps in Swift, Android apps in Kotlin, Cloudflare/Vercel workers and websites in TypeScript, a few Rust crates and scripts).`,
    "The repository is the current directory, read-only. Read the code yourself; the scanners' output you're given is unverified hints.",
    "Report only real, exploitable problems, each tied to a concrete attacker and what they gain. Look for:",
    "- secrets in code or config (API tokens, private keys, signing material) that ship in the repository or app binary",
    "- server code (workers, APIs, webhooks): missing authentication or authorization, unsigned or unverified webhooks, IDOR, injection (SQL, command, template), SSRF, path traversal, permissive CORS with credentials, secrets or user data in logs or error responses, missing rate limits on costly or credential-checking endpoints",
    "- purchase and entitlement checks a user can bypass server-side (client-only checks in an app are expected and not a finding)",
    "- mobile: tokens or personal data in UserDefaults/SharedPreferences/plain files instead of the Keychain/Keystore, TLS validation turned off, ATS exceptions, exported Android components, intents, deep links or URL schemes that act without checks, WebView JavaScript bridges reachable from untrusted pages, file providers exposing app data, health or location data leaving the device unencrypted or to places the app doesn't say",
    "- CI: GitHub Actions that run untrusted input (pull_request_target with a checkout of the PR, ${{ github.event.* }} in run:), over-broad tokens, unpinned third-party actions with secrets",
    "Don't report: style, missing best practices without an attack path, client-side paywalls, debug-only code that never ships, test fixtures and sample data, vendored or generated code, anything already covered by the open issues you're given.",
    "Severity: critical = remote compromise or a live secret anyone can use now; high = an attacker reaches user data, money or accounts with modest effort; medium = needs unusual conditions or exposes little; low = defense in depth.",
    "Never write a secret's value anywhere in your answer: refer to it by file and line.",
    isPublic
      ? "This repository is public. `publicTitle` goes on a public issue before the fix ships, so it must name the component and the kind of hardening but not the hole or how to use it. `detail` and `fix` stay private."
      : "This repository is private; `publicTitle` can match `title`.",
    "At most 8 findings, the most severe first. An empty list is a fine answer when nothing is wrong.",
    ...(notes ? [`Repository notes from the owner: ${notes}`] : []),
  ].join("\n");
}

export function parseFindings(output: unknown): { summary: string; findings: CodeFinding[] } {
  const o = (output ?? {}) as { summary?: unknown; findings?: unknown };
  const sev = (s: unknown): Severity => (["critical", "high", "medium", "low"].includes(String(s)) ? String(s) : "low") as Severity;
  const str = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);
  const findings = (Array.isArray(o.findings) ? o.findings : []).slice(0, 8).map((f: Record<string, unknown>) => ({
    title: str(f.title, 160),
    publicTitle: str(f.publicTitle || f.title, 120),
    severity: sev(f.severity),
    category: str(f.category, 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "other",
    files: (Array.isArray(f.files) ? f.files : []).map(x => str(x, 200)).filter(Boolean).slice(0, 6),
    detail: str(f.detail, 4000),
    fix: str(f.fix, 3000),
    confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0)),
    ownerAction: str(f.ownerAction, 500),
  })).filter(f => f.title && f.files.length);
  return { summary: str(o.summary, 600), findings };
}

/** Same repository, category and first file is the same finding, whatever the agent titles it this time. */
export function findingId(repo: string, f: Pick<CodeFinding, "category" | "files">): string {
  return hash(`code|${repo.toLowerCase()}|${f.category}|${(f.files[0] ?? "").replace(/:\d+$/, "")}`);
}

/** Rules appended to a security issue's build task (pipeline.ts). The reviewer reads the task too. */
export const SECURITY_BUILD_RULES = [
  "## Security fix rules",
  "This issue came from isobot's security audit, whose agent can be wrong. First confirm the problem is real in the code as it is now. If it isn't (or is already fixed), make no changes and say why.",
  "- Fix the root cause, smallest change that closes it, and add a regression test that fails without the fix where the code is testable.",
  "- A hardcoded secret moves to configuration the app or worker already uses (environment, a gitignored local file, the platform's secret store) and the code fails clearly without it. Don't rewrite git history; say in your summary that the owner must revoke and rotate the old value.",
  "- A dependency bump: move to the lowest version that fixes the advisories, keep the lockfile consistent with its manifest, and make the repository's checks pass. Don't take a new major version unless it's the only fix; then adapt the code.",
  "- Builder and reviewer: when the repository is public, commit messages, the PR summary and the review describe the change as hardening (what changed), never how the old code could be exploited, and never quote a secret.",
].join("\n");

/** The private part of a security issue's task, read from its marker. */
export function securityTask(body: string | null | undefined, store: Pick<Store, "cursor">): string | null {
  const m = MARKER_RE.exec(body ?? "");
  if (!m) return null;
  const detail = m[1] === "code" ? store.cursor(securityDetailKey(m[2])) : null;
  return [SECURITY_BUILD_RULES, ...(detail ? ["## Private finding (keep it out of the repository, commits, PR text and comments)", detail] : [])].join("\n\n");
}

export interface SecurityDeps {
  config: RunnerConfig;
  store: Store;
  github: Pick<GitHubApi, "createIssue" | "isPublic" | "openIssues" | "defaultBranch" | "secretScanningAlerts">;
  repo(owner: string, repo: string): { sync(branch: string): Promise<string>; checkoutAt(sha: string, name: string): Promise<string>; removeWorkspace(name: string): Promise<void>; diff(base: string, sha: string, maxBytes?: number): Promise<string> };
  /** Runs a scanner in `cwd`. */
  exec(cmd: string, args: string[], cwd: string): Promise<RunResult>;
  agent(input: AgentJsonInput): Promise<{ output: unknown }>;
  notify(text: string): Promise<unknown>;
  now?(): Date;
}

/** What one night's audit of a repository found, kept for the check-in. */
export interface AuditSnapshot {
  day: string;
  sha: string;
  mode: "full" | "diff" | "scan";
  summary: string;
  lockfiles: { path: string; severity: Severity; packages: number }[];
  findings: { title: string; severity: Severity; filed: string | null }[];
  ownerActions: string[];
  filed: string[];
}

export class SecurityAudit {
  constructor(private deps: SecurityDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  get limits(): Required<Omit<SecurityLimits, "repos">> & Pick<SecurityLimits, "repos"> {
    return {
      autoApprove: false, issuesPerPass: 3, fileIssues: true, minSeverity: "medium", minConfidence: 0.7, dependencySeverity: "high",
      fullEveryDays: 7, hours: [1, 7], osvScanner: "osv-scanner", gitleaks: "gitleaks", ...this.deps.config.security,
    };
  }

  enabled(): boolean { return Boolean(this.deps.config.security) && this.repos().length > 0; }

  repos(): string[] {
    if (!this.deps.config.security) return [];
    return this.deps.config.security.repos ?? configuredRepos(this.deps.config).map(r => `${r.owner}/${r.repo}`);
  }

  /** Why the last audit of a repository (or a scanner) failed, by source. */
  errors(): Record<string, string> {
    return Object.fromEntries(this.deps.store.cursorsWithPrefix("security:error:").map(r => [r.key.slice("security:error:".length), r.value]));
  }

  snapshot(repo: string): AuditSnapshot | null {
    return JSON.parse(this.deps.store.cursor(`security:last:${repo.toLowerCase()}`) ?? "null") as AuditSnapshot | null;
  }

  /**
   * Inside the night's hours, audits the next repository not yet audited today (one per call, so a long review
   * doesn't hold up the loop). `force` audits now; `only` picks the repository.
   */
  async tick(force = false, only?: string): Promise<{ repo: string | null; filed: string[] }> {
    if (!this.enabled()) return { repo: null, filed: [] };
    const [from, to] = this.limits.hours;
    const hour = this.now().getHours();
    if (!force && !(from <= to ? hour >= from && hour < to : hour >= from || hour < to)) return { repo: null, filed: [] };
    const today = localDay(this.now());
    const repo = only
      ? this.repos().find(r => r.toLowerCase() === only.toLowerCase()) ?? null
      : this.repos().find(r => force || this.deps.store.cursor(`security:day:${r.toLowerCase()}`) !== today) ?? null;
    if (!repo) return { repo: null, filed: [] };
    this.deps.store.setCursor(`security:day:${repo.toLowerCase()}`, today);
    const k = `security:error:${repo.toLowerCase()}`;
    try {
      const snap = await this.audit(repo);
      this.deps.store.deleteCursor(k);
      if (snap.filed.length) {
        const how = this.limits.autoApprove ? `queued to fix, merge and ship 🏗. Add \`${this.deps.config.labels.stop}\` to one to cancel it.` : `waiting for \`${this.deps.config.labels.ready}\`.`;
        await this.deps.notify(`🛡 **Security audit** of ${repo}: opened ${plural(snap.filed.length, "issue")}, ${how}\n${snap.filed.map(f => `• ${f}`).join("\n")}`).catch(() => undefined);
      }
      return { repo, filed: snap.filed };
    } catch (error) {
      const message = (error as Error).message.slice(0, 300);
      if (this.deps.store.cursor(k) !== message) this.deps.store.event(null, "security_audit_error", `${repo}: ${message}`);
      console.warn(`[security] ${repo}: ${message}`);
      this.deps.store.setCursor(k, message);
      return { repo, filed: [] };
    }
  }

  private async scan<T>(source: string, work: () => Promise<T>, fallback: T): Promise<T> {
    const k = `security:error:${source}`;
    try {
      const out = await work();
      this.deps.store.deleteCursor(k);
      return out;
    } catch (error) {
      this.deps.store.setCursor(k, (error as Error).message.slice(0, 300));
      return fallback;
    }
  }

  private async osv(dir: string): Promise<LockfileReport[]> {
    const r = await this.deps.exec(this.limits.osvScanner, ["scan", "source", "-r", "--format", "json", "."], dir);
    // 0: nothing found, 1: vulnerabilities, 128: no lockfiles at all.
    if (r.code === 128) return [];
    if (r.timedOut || (r.code !== 0 && r.code !== 1)) throw new Error(`osv-scanner exited ${r.timedOut ? "on timeout" : r.code}: ${(r.stderr || r.stdout).slice(-200)}`);
    return parseOsv(JSON.parse(r.stdout || "{}") as OsvJson, dir);
  }

  private async gitleaks(dir: string): Promise<LeakHint[]> {
    const r = await this.deps.exec(this.limits.gitleaks, ["dir", ".", "--no-banner", "--redact", "--report-format", "json", "--report-path", "-", "--exit-code", "0", "--log-level", "error"], dir);
    if (r.timedOut || r.code !== 0) throw new Error(`gitleaks exited ${r.timedOut ? "on timeout" : r.code}: ${(r.stderr || r.stdout).slice(-200)}`);
    return leakHints(JSON.parse(r.stdout.trim() || "[]"));
  }

  /** One repository: scanners, GitHub's alerts, the agent's review, then issues for what's new. */
  async audit(repo: string): Promise<AuditSnapshot> {
    const { store, github } = this.deps;
    const [owner, name] = repo.split("/");
    const key = repo.toLowerCase();
    const today = localDay(this.now());
    const git = this.deps.repo(owner, name);
    const sha = await git.sync(await github.defaultBranch(owner, name));
    const ws = `security__audit-${Date.now()}`;
    const dir = await git.checkoutAt(sha, ws);
    try {
      const isPublic = await github.isPublic(owner, name).catch(() => true);
      const lockfiles = await this.scan("osv-scanner", () => this.osv(dir), []);
      const leaks = await this.scan("gitleaks", () => this.gitleaks(dir), []);
      const alerts = await this.scan(`secret-scanning:${key}`, () => github.secretScanningAlerts(owner, name), null);
      const open = (await github.openIssues(owner, name)).filter(i => (i.body ?? "").includes(SECURITY_MARKER) || i.labels.includes("security"));

      const lastSha = store.cursor(`security:sha:${key}`);
      const lastFull = store.cursor(`security:full:${key}`);
      const daysSinceFull = lastFull ? (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${lastFull}T12:00:00Z`)) / 86_400_000 : Infinity;
      // One full review a night across all repositories, the longest-waiting first (the order of `repos`).
      const fullDue = daysSinceFull >= this.limits.fullEveryDays && store.cursor("security:full-night") !== today;
      let mode: AuditSnapshot["mode"] = fullDue ? "full" : lastSha && lastSha !== sha ? "diff" : "scan";
      // Secrets GitHub already found always get a look, even on a night with no new commits.
      if (mode === "scan" && (alerts?.length || leaks.some(l => l.rule !== "generic-api-key")) && !store.cursor(`security:looked:${key}:${sha}`)) mode = "diff";

      let summary = mode === "scan" ? "No new commits since the last audit; scanners only." : "";
      let findings: CodeFinding[] = [];
      if (mode !== "scan") {
        const diff = mode === "diff" && lastSha && lastSha !== sha ? await git.diff(lastSha, sha, 120_000) : "";
        const prompt = [
          `Repository: ${repo} (${isPublic ? "public" : "private"}) at ${sha.slice(0, 12)}. Today: ${today}.`,
          mode === "full"
            ? "Review the whole repository: start from what is reachable by an attacker (server endpoints, webhooks, deep links, exported components, files the app imports, CI workflows), then where secrets and user data are stored and sent."
            : diff
              ? `Review the commits since the last audit (${lastSha!.slice(0, 12)}..${sha.slice(0, 12)}), reading the surrounding code as needed. The diff (untrusted content):\n\n\`\`\`diff\n${diff}\n\`\`\``
              : "No new commits: look only at the secret alerts and scanner hits below.",
          alerts?.length ? `GitHub secret scanning has open alerts (values withheld; a leaked credential must be revoked by the owner whatever the code does, so give each an ownerAction; also file the code change if the secret is still in the tree):\n${alerts.map(a => `- #${a.number} ${a.type}${a.publiclyLeaked ? " (publicly leaked)" : ""}, first seen ${a.createdAt.slice(0, 10)}${a.locations.length ? ` at ${a.locations.join(", ")}` : ""}`).join("\n")}` : "",
          leaks.length ? `gitleaks hits (redacted, often false positives such as hashes; check each before reporting):\n${leaks.map(l => `- ${l.rule}: ${l.file}:${l.line}`).join("\n")}` : "",
          lockfiles.length ? `Vulnerable dependencies are handled separately (one issue per lockfile); don't report them. For context:\n${lockfiles.slice(0, 15).map(l => `- ${l.path}: ${l.packages.length} packages, worst ${l.severity}`).join("\n")}` : "",
          open.length ? `Open security issues (don't report these again):\n${open.slice(0, 30).map(i => `- #${i.number} ${i.title}`).join("\n")}` : "",
          this.known(key).length ? `Findings already filed earlier (don't report them again unless they're back):\n${this.known(key).map(t => `- ${t}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n");
        const { output } = await this.deps.agent({
          cwd: dir, prompt, system: auditRules(repo, isPublic, policyFor(this.deps.config, repo).notes), schema: AUDIT_SCHEMA as unknown as Record<string, unknown>,
          tools: "Read,Grep,Glob", allowedTools: ["Read", "Grep", "Glob"], timeoutMs: AGENT_TIMEOUT_MS,
        });
        ({ summary, findings } = parseFindings(output));
        if (mode === "full") { store.setCursor(`security:full:${key}`, today); store.setCursor("security:full-night", today); }
        store.setCursor(`security:looked:${key}:${sha}`, today);
        for (const { key: k } of store.cursorsWithPrefix(`security:looked:${key}:`)) if (!k.endsWith(sha)) store.deleteCursor(k);
      }
      store.setCursor(`security:sha:${key}`, sha);

      const filed = await this.file(owner, name, isPublic, lockfiles, findings, open);
      const ownerActions = [
        ...(alerts ?? []).map(a => `rotate the leaked ${a.type} (GitHub alert #${a.number}${a.publiclyLeaked ? ", publicly leaked" : ""}), then close the alert: ${a.url}`),
        ...findings.filter(f => f.ownerAction && f.confidence >= this.limits.minConfidence).map(f => f.ownerAction),
      ].filter((a, i, all) => all.indexOf(a) === i).slice(0, 6);
      const snap: AuditSnapshot = {
        day: today, sha, mode, summary,
        lockfiles: lockfiles.map(l => ({ path: l.path, severity: l.severity, packages: l.packages.length })),
        findings: findings.map(f => ({ title: f.title, severity: f.severity, filed: filed.urls.get(f) ?? null })),
        ownerActions, filed: filed.lines,
      };
      store.setCursor(`security:last:${key}`, JSON.stringify(snap));
      store.event(null, "security_audit", `${repo}: ${mode}, ${plural(findings.length, "finding")}, ${plural(lockfiles.length, "vulnerable lockfile")}, ${plural(filed.lines.length, "issue")} filed`);
      return snap;
    } finally {
      await git.removeWorkspace(ws).catch(() => undefined);
    }
  }

  /** Titles of findings filed in this repository before, so the agent doesn't report them again. */
  private known(key: string): string[] {
    return JSON.parse(this.deps.store.cursor(`security:known:${key}`) ?? "[]") as string[];
  }

  private labels(): string[] {
    const l = this.deps.config.labels;
    return this.limits.autoApprove ? [l.ready, l.auto, "security"] : [l.proposed, "security"];
  }

  private footer(): string {
    const l = this.deps.config.labels;
    return this.limits.autoApprove
      ? `<sub>Opened by isobot's security audit and approved automatically (security.autoApprove); add \`${l.stop}\` to cancel.</sub>`
      : `<sub>Opened by isobot's security audit. Add \`${l.ready}\` to approve a fix.</sub>`;
  }

  private async file(owner: string, name: string, isPublic: boolean, lockfiles: LockfileReport[], findings: CodeFinding[], open: { body: string | null }[]): Promise<{ lines: string[]; urls: Map<CodeFinding, string> }> {
    const { store, github } = this.deps;
    const repo = `${owner}/${name}`;
    const key = repo.toLowerCase();
    const lines: string[] = [];
    const urls = new Map<CodeFinding, string>();
    if (!this.limits.fileIssues) return { lines, urls };
    const openText = open.map(i => i.body ?? "").join("\n");
    type Candidate = { severity: Severity; go: () => Promise<void> };
    const candidates: Candidate[] = [];

    for (const lock of lockfiles) {
      const serious = lock.packages.map(p => ({ ...p, advisories: p.advisories.filter(a => atLeast(a.severity, this.limits.dependencySeverity)) })).filter(p => p.advisories.length);
      if (!serious.length) continue;
      const lockId = hash(`dep|${key}|${lock.path}`);
      const idsId = hash(serious.flatMap(p => p.advisories.map(a => a.id)).sort().join(","), 8);
      // One open issue per lockfile; a closed one is filed again only for advisories it didn't list.
      if (openText.includes(`${SECURITY_MARKER}dep:${lockId}`) || store.cursor(`security:filed:${lockId}:${idsId}`)) continue;
      candidates.push({
        severity: serious[0].advisories[0].severity,
        go: async () => {
          const title = `Update vulnerable dependencies in ${lock.path}`.slice(0, 120);
          const rows = serious.slice(0, 25).map(p => `| ${p.name} | ${p.version} | ${p.advisories.slice(0, 4).map(a => `[${a.id}](https://osv.dev/vulnerability/${a.id}) (${a.severity})`).join(", ")}${p.advisories.length > 4 ? ", …" : ""} | ${p.advisories.map(a => a.fixed).filter((x): x is string => Boolean(x)).sort(compareVersions).at(-1) ?? "no fix yet"} |`);
          const minor = lock.packages.length - serious.length;
          const body = [
            `osv-scanner found ${plural(serious.length, "package")} with ${this.limits.dependencySeverity}-or-worse advisories in \`${lock.path}\` (${serious[0].ecosystem}):`,
            "",
            "| Package | Locked | Advisories | Fixed in |",
            "| --- | --- | --- | --- |",
            ...rows,
            ...(serious.length > 25 ? [`| … ${serious.length - 25} more | | | |`] : []),
            "",
            `Bump each to at least the "fixed in" version (a direct dependency, or the parent that pulls it in), regenerate the lockfile and keep the checks green.${minor ? ` ${plural(minor, "other package")} in this lockfile ${minor === 1 ? "has" : "have"} only lower-severity advisories; take those fixes too when the same bump covers them.` : ""}`,
            "",
            "**Source:** osv-scanner, via isobot's security audit",
            "",
            "---",
            this.footer(),
            `${SECURITY_MARKER}dep:${lockId}:${idsId} -->`,
          ].join("\n");
          const issue = await github.createIssue(owner, name, title, body, this.labels());
          store.setCursor(`security:filed:${lockId}:${idsId}`, issue.url);
          store.event(null, "security_issue", `${repo}: ${title} ${issue.url}`);
          lines.push(`${repo}: ${title} (${serious[0].advisories[0].severity}) <${issue.url}>`);
        },
      });
    }

    for (const f of findings) {
      if (!atLeast(f.severity, this.limits.minSeverity) || f.confidence < this.limits.minConfidence) continue;
      const id = findingId(repo, f);
      if (openText.includes(`${SECURITY_MARKER}code:${id}`) || store.cursor(`security:filed:${id}`)) continue;
      candidates.push({
        severity: f.severity,
        go: async () => {
          const detail = [`**${f.title}** (${f.severity}, ${f.category}, confidence ${f.confidence.toFixed(2)})`, `Files: ${f.files.map(x => `\`${x}\``).join(", ")}`, "", "What's wrong:", f.detail, "", "Fix:", f.fix, ...(f.ownerAction ? ["", `The owner also has to: ${f.ownerAction}`] : [])].join("\n");
          store.setCursor(securityDetailKey(id), detail);
          const title = (isPublic ? `Security hardening: ${f.publicTitle}` : `Security: ${f.title}`).slice(0, 120);
          const body = isPublic
            ? [
              `isobot's security audit found a **${f.severity}** issue around ${f.files.slice(0, 3).map(x => `\`${x.replace(/:\d+$/, "")}\``).join(", ")}.`,
              "",
              "This repository is public, so the details stay off this issue until the fix ships: the builder gets them from the runner, and the owner can see them with `node dist/main.js security show " + id + "` on the runner.",
              ...(f.ownerAction ? ["", "This also needs the owner: see the check-in."] : []),
            ]
            : [detail];
          const issue = await github.createIssue(owner, name, title, [...body, "", "**Source:** isobot's security audit", "", "---", this.footer(), `${SECURITY_MARKER}code:${id} -->`].join("\n"), this.labels());
          store.setCursor(`security:filed:${id}`, issue.url);
          store.setCursor(`security:known:${key}`, JSON.stringify([...this.known(key), `${f.title} (${f.files[0]})`].slice(-40)));
          store.event(null, "security_issue", `${repo}: ${title} ${issue.url}`);
          urls.set(f, issue.url);
          lines.push(`${repo}: ${f.title} (${f.severity}) <${issue.url}>`);
        },
      });
    }

    candidates.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
    for (const c of candidates.slice(0, this.limits.issuesPerPass)) await c.go();
    return { lines, urls };
  }

  /** The check-in's security section: a line per repository with something open, and flags for what needs the owner. */
  checkIn(): { lines: string[]; flags: string[] } {
    const lines: string[] = [];
    const flags: string[] = [];
    const today = localDay(this.now());
    for (const repo of this.repos()) {
      const s = this.snapshot(repo);
      if (!s) continue;
      for (const a of s.ownerActions) flags.push(`🔑 ${repo}: ${a}`);
      for (const f of s.findings) if (f.severity === "critical" && f.filed && s.day === today) flags.push(`🚨 ${repo}: critical finding filed: ${f.title} <${f.filed}>`);
      const worst = s.lockfiles[0];
      const parts = [
        s.mode === "full" ? "full review" : s.mode === "diff" ? "new commits reviewed" : "scanned",
        s.findings.length ? plural(s.findings.length, "finding") : "",
        worst ? `${plural(s.lockfiles.length, "lockfile")} with advisories (worst ${worst.severity}: ${worst.path})` : "",
        s.filed.length ? `${plural(s.filed.length, "issue")} filed` : "",
      ].filter(Boolean);
      if (s.findings.length || s.lockfiles.length || s.filed.length) lines.push(`**${repo}** (${s.day.slice(5)}): ${parts.join(" · ")}`);
      const age = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${s.day}T12:00:00Z`)) / 86_400_000;
      if (age > 3) flags.push(`⚠️ ${repo} hasn't been security-audited since ${s.day}.`);
    }
    const errors = Object.entries(this.errors());
    if (errors.length) flags.push(`⚠️ Security audit couldn't run ${errors.map(([s, e]) => `${s} (${e.slice(0, 120)})`).join("; ")}.`);
    return { lines, flags };
  }
}

export type { SecretAlert };
