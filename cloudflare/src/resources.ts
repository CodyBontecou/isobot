import type { Harness, UsageState } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import type { Workspace } from "./workspace.js";

const context: Parameters<Harness["close"]>[0] = Object.freeze({
  abortSignal: undefined, value: () => undefined, toString: () => "[Context isobot resources]",
});
const WORKERS_PRICING = "https://developers.cloudflare.com/workers/platform/pricing/";
const OBJECT_PRICING = "https://developers.cloudflare.com/durable-objects/platform/pricing/";
const AI_PRICING = "https://developers.cloudflare.com/workers-ai/platform/pricing/";

export interface ResourceEnvironment {
  AI?: unknown;
  Assistant?: unknown;
  Isobot?: unknown;
  DeliveryInbox?: unknown;
  ChatGPTAuth?: unknown;
  AccountAuth?: unknown;
  ASSETS?: unknown;
}
export interface ResourceUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  recordedCatalogEstimateUSD: number;
}
export interface ResourceSnapshot {
  runtime: { model: string; provider: "workers-ai" | "chatgpt"; harness: "PiHarness"; busy: boolean; pendingCount: number; sessionCount: number };
  storage: { databaseBytes: number; workspaceFiles: number; workspaceBytes: number; captures: number };
  usage: ResourceUsage & { scope: "assistant lifetime"; models: (ResourceUsage & { key: string })[] };
  bindings: { name: string; kind: string; description: string }[];
  pricing: ReturnType<typeof publishedPricing>;
}

const nonnegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

/** These are provider-reported counters and Pi catalog estimates, never Cloudflare billing data. */
export function summarizeResourceUsage(state: UsageState): ResourceSnapshot["usage"] {
  const project = (usage: UsageState["models"][string]): ResourceUsage => ({
    inputTokens: nonnegative(usage.input), outputTokens: nonnegative(usage.output),
    cacheReadTokens: nonnegative(usage.cacheRead), cacheWriteTokens: nonnegative(usage.cacheWrite),
    totalTokens: nonnegative(usage.totalTokens), recordedCatalogEstimateUSD: nonnegative(usage.cost.total),
  });
  const totals: ResourceUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, totalTokens: 0, recordedCatalogEstimateUSD: 0 };
  for (const bucket of [state.models, state.tools]) for (const usage of Object.values(bucket)) {
    const projected = project(usage);
    for (const key of Object.keys(totals) as (keyof ResourceUsage)[]) totals[key] += projected[key];
  }
  return { ...totals, scope: "assistant lifetime",
    models: Object.entries(state.models).map(([key, usage]) => ({ key, ...project(usage) })) };
}

/** Explicit public binding names keep secrets and unrelated environment values out of the response. */
export function configuredResourceBindings(env: ResourceEnvironment): ResourceSnapshot["bindings"] {
  const configured: ResourceSnapshot["bindings"] = [
    { name: "AI", kind: "Workers AI", description: "Cloudflare model inference" },
    { name: "Assistant", kind: "Durable Object", description: "Conversations, workspace and captured notes in SQLite" },
    { name: "Isobot", kind: "Durable Object", description: "Discord ticket operations" },
    { name: "DeliveryInbox", kind: "Durable Object", description: "Durable delivery receipts" },
    { name: "ChatGPTAuth", kind: "Durable Object", description: "ChatGPT connection and model selection" },
    { name: "AccountAuth", kind: "Durable Object", description: "Console accounts and sessions" },
    { name: "ASSETS", kind: "Static assets", description: "Console interface assets" },
  ];
  return configured.filter(binding => env[binding.name as keyof ResourceEnvironment] !== undefined);
}

/** Public paid-plan unit rates checked against Cloudflare's pricing pages on October 7, 2026. */
export function publishedPricing(model: string, databaseBytes: number) {
  const modelRate: { source: string; label: string; inputPerMillion?: number; outputPerMillion?: number; cachedInputPerMillion?: number } =
    model === "@cf/moonshotai/kimi-k2.7-code"
      ? { source: AI_PRICING, label: "Workers AI token rates", inputPerMillion: 0.95, outputPerMillion: 4, cachedInputPerMillion: 0.19 }
      : model.startsWith("@cf/")
        ? { source: AI_PRICING, label: "See Cloudflare for this model's current token rates" }
        : { source: "https://chatgpt.com/#settings/Account", label: "ChatGPT subscription; billed usage unavailable here" };
  return {
    currency: "USD" as const, checkedAt: "2026-10-07", actualBill: null,
    model: modelRate,
    rates: [
      { label: "Workers paid plan", unit: "account/month", usd: 5, included: "Minimum account charge; shared across projects", source: WORKERS_PRICING },
      { label: "Worker requests", unit: "million requests", usd: 0.30, included: "10 million/month included", source: WORKERS_PRICING },
      { label: "Worker CPU", unit: "million CPU milliseconds", usd: 0.02, included: "30 million/month included", source: WORKERS_PRICING },
      { label: "Durable Object requests", unit: "million requests", usd: 0.15, included: "1 million/month included", source: OBJECT_PRICING },
      { label: "Durable Object duration", unit: "million GB-seconds", usd: 12.50, included: "400,000 GB-seconds/month included", source: OBJECT_PRICING },
      { label: "SQLite reads", unit: "million rows", usd: 0.001, included: "25 billion rows/month included", source: OBJECT_PRICING },
      { label: "SQLite writes", unit: "million rows", usd: 1, included: "50 million rows/month included", source: OBJECT_PRICING },
      { label: "SQLite storage", unit: "GB-month", usd: 0.20, included: "5 GB-month included", source: OBJECT_PRICING },
    ],
    storageEstimateUSDPerMonth: nonnegative(databaseBytes) / 1_000_000_000 * 0.20,
    notes: [
      "Unit rates are published Workers Paid plan rates. Your plan and account-wide included allowances are not known here.",
      "Storage estimate holds the current SQLite size for one month at the gross unit rate before included allowances.",
      "Token usage covers all Pi sessions in this assistant over their lifetime, not the current billing month. Providers may omit some counters.",
      "Pi's recorded catalog estimate is not a charge or invoice. ChatGPT subscription usage is not billed at Workers AI token rates.",
      "Platform request, CPU, active duration and account billing totals require Cloudflare's dashboard; they are not measured by this endpoint.",
    ],
  };
}

/** Read real persisted agent usage and current database size without asking the model to run. */
export async function resourceSnapshot(
  harness: PiHarness, workspace: Workspace, sql: SqlStorage, env: ResourceEnvironment, model: string,
): Promise<ResourceSnapshot> {
  const pi = await harness.pi();
  const [usage, busy, pending, sessions] = await Promise.all([
    pi.usage(context), harness.session().busy(), harness.pending(), harness.sessions.list(),
  ]);
  const files = workspace.list();
  const captures = sql.exec<{ count: number }>("SELECT count(*) AS count FROM api_captured_notes").one().count;
  const databaseBytes = sql.databaseSize;
  return {
    runtime: { model, provider: model.startsWith("@cf/") ? "workers-ai" : "chatgpt", harness: "PiHarness",
      busy, pendingCount: pending.length, sessionCount: sessions.length },
    storage: { databaseBytes, workspaceFiles: files.files.length, workspaceBytes: files.totalBytes, captures },
    usage: summarizeResourceUsage(usage), bindings: configuredResourceBindings(env),
    pricing: publishedPricing(model, databaseBytes),
  };
}
