import { DurableObject } from "cloudflare:workers";
import { AccountStore, type AccountInput, type ApiTokenInput, type ApiTokenScope, type NativeCodeInput, type OAuthFlowInput, type SessionInput } from "./account-store.js";

/** Private RPC authority for GitHub accounts, browser sessions and scoped API tokens. */
export class AccountAuth extends DurableObject<unknown> {
  private readonly accounts: AccountStore;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.accounts = new AccountStore(ctx.storage);
  }
  createFlow(input: OAuthFlowInput) { return this.accounts.createFlow(input); }
  consumeFlow(input: { state: string }) { return this.accounts.consumeFlow(input); }
  createNativeCode(input: NativeCodeInput) { return this.accounts.createNativeCode(input); }
  consumeNativeCode(input: { code: string; codeVerifier: string }) { return this.accounts.consumeNativeCode(input); }
  upsertAccount(input: AccountInput) { return this.accounts.upsertAccount(input); }
  getAccount(input: { accountId: string }) { return this.accounts.getAccount(input.accountId); }
  createSession(input: SessionInput) { return this.accounts.createSession(input); }
  validateSession(input: { credential: string }) { return this.accounts.validateSession(input); }
  revokeSession(input: { credential: string }) { return this.accounts.revokeSession(input); }
  createApiToken(input: ApiTokenInput) { return this.accounts.createApiToken(input); }
  validateApiToken(input: { credential: string; scope: ApiTokenScope }) { return this.accounts.validateApiToken(input); }
  listApiTokens(input: { accountId: string }) { return this.accounts.listApiTokens(input); }
  revokeApiToken(input: { accountId: string; tokenId: string }) { return this.accounts.revokeApiToken(input); }
  cleanup() { return this.accounts.cleanup(); }
}
