import { DurableObject } from "cloudflare:workers";
import { ChatGPTAuthController, type ChatGPTAuthState, type ChatGPTCredential, type ChatGPTSelection, type ChatGPTStatus } from "./chatgpt-auth-store.js";

export { ChatGPTAuthError, validateChatGPTCredential } from "./chatgpt-auth-store.js";
export type { ChatGPTCredential, ChatGPTSelection, ChatGPTStatus } from "./chatgpt-auth-store.js";

/** Every agent uses the same `primary` object; refresh tokens never enter conversation storage. */
export class ChatGPTAuth extends DurableObject<Env> {
  private readonly auth: ChatGPTAuthController;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.auth = new ChatGPTAuthController({
      read: () => this.ctx.storage.get<ChatGPTAuthState>("chatgpt-auth"),
      write: state => this.ctx.storage.put("chatgpt-auth", state),
    });
  }

  importCredential(credential: ChatGPTCredential): Promise<ChatGPTStatus> { return this.auth.connect(credential); }
  getHostId(): Promise<string> { return this.auth.getHostId(); }
  status(): Promise<ChatGPTStatus> { return this.auth.status(); }
  refreshCatalog(): Promise<ChatGPTStatus> { return this.auth.refreshCatalog(); }
  getAccessToken(): Promise<string> { return this.auth.getAccessToken(); }
  selectModel(model: string, verifyUnlisted = false): Promise<ChatGPTStatus> { return this.auth.selectModel(model, verifyUnlisted); }
  getSelection(): Promise<ChatGPTSelection> { return this.auth.getSelection(); }
  useWorkersAI(): Promise<ChatGPTStatus> { return this.auth.useWorkersAI(); }
  disconnect(): Promise<{ revoked: boolean }> { return this.auth.disconnect(); }
}
