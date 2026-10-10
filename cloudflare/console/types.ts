export interface User { id: string | number; login: string; name?: string }
export type Auth = { mode: 'session'; csrfToken: string; user: User } | { mode: 'bearer'; token: string };
export interface Entry {
  id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; createdAt?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolResult?: { name: string; id: string; error: boolean };
}
export interface Snapshot { model: string; busy: boolean; pending: { operationId: string; status: string }[]; entries: Entry[]; nextCursor?: string }
export interface Job { id: string; prompt: string; status: 'pending' | 'failed' | 'done'; error?: string; text?: string; baseline: string[] }
export interface WorkspaceFile { path: string; bytes: number; revision: number; updatedAt: string; content?: string }
export interface Workspace { files: WorkspaceFile[]; totalBytes: number; maxFileBytes: number; maxFiles: number }
export interface Capture { id: string; mode: 'memory' | 'prompt'; preview?: string; status?: string; receivedAt: string; markdown?: string; payload?: unknown; result?: { status: string; text?: string; reason?: string } }
export interface Resources {
  runtime: { model: string; provider: string; harness: string; busy: boolean; pendingCount: number; sessionCount: number };
  storage: { databaseBytes: number; workspaceFiles: number; workspaceBytes: number; captures: number };
  usage: { scope: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; recordedCatalogEstimateUSD: number; models: { key: string; totalTokens: number; recordedCatalogEstimateUSD: number }[] };
  bindings: { name: string; kind: string; description: string }[];
  pricing: { checkedAt: string; actualBill: null; model: { source: string; label: string; inputPerMillion?: number; outputPerMillion?: number; cachedInputPerMillion?: number }; rates: { label: string; unit: string; usd: number; included?: string; source: string }[]; storageEstimateUSDPerMonth: number; notes: string[] };
}
export interface AccountToken { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null }
export type Api = <T>(path: string, options?: RequestInit, query?: Record<string, string | number | undefined>, scoped?: boolean) => Promise<T>;
