import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Provider, Model, Api, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { PiHarness } from "agents/harness/pi";
import type { Harness } from "@earendil-works/pi-durable";

const modelContext: Parameters<Harness["close"]>[0] = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "[Context isobot model selection]",
});

export interface ChatGPTConnection {
  getAccessToken(): Promise<string>;
  getSelection(): Promise<{ model: string | null; revision: number }>;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const unsupported = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata",
  "moderation", "multi_agent", "prompt", "prompt_cache_retention", "prompt_cache_options",
  "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user",
  "previous_response_id",
];

/** Apply the ChatGPT plan's wire contract after Pi has assembled its request. */
export function chatgptPayload(payload: unknown, model: Pick<Model<Api>, "provider">): unknown {
  if (model.provider !== "openai") return payload;
  if (!object(payload)) throw new Error("Invalid ChatGPT request payload");
  const next: JsonObject = { ...payload, store: false, stream: true };
  for (const field of unsupported) delete next[field];
  const names = new Set<string>();
  const group = (tools: unknown[]): unknown[] => {
    const local = tools.filter((tool): tool is JsonObject => object(tool) && (tool.type === "function" || tool.type === "custom"));
    for (const tool of local) if (typeof tool.name === "string") names.add(tool.name);
    return local.length ? [
      ...tools.filter(tool => !object(tool) || (tool.type !== "function" && tool.type !== "custom")),
      { type: "namespace", name: "isobot", description: "Isobot's tools", tools: local },
    ] : tools;
  };
  if (Array.isArray(next.tools)) next.tools = group(next.tools);
  if (Array.isArray(next.input)) next.input = next.input.map(item => {
    if (object(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
      return { ...item, role: "developer", tools: group(item.tools) };
    }
    return item;
  });
  if (Array.isArray(next.input)) next.input = next.input.map(item => {
    if (!object(item)) return item;
    if (item.role === "system") return { ...item, role: "developer" };
    // Old Workers AI and other-model calls have no namespace. Preserve their tool history.
    if ((item.type === "function_call" || item.type === "custom_tool_call") && names.has(String(item.name))) {
      return { ...item, namespace: "isobot" };
    }
    return item;
  });
  if (object(next.tool_choice) && names.has(String(next.tool_choice.name))) {
    next.tool_choice = { ...next.tool_choice, namespace: "isobot" };
  }
  return next;
}

export function chatgptStreamEvent(event: unknown, model: Pick<Model<Api>, "provider">): void {
  if (model.provider === "openai" && object(event) && event.type === "response.incomplete") {
    throw new Error("ChatGPT did not complete the response");
  }
}

type RequestHooks = Pick<SimpleStreamOptions, "onPayload" | "onProviderStreamEvent" | "maxRetries">;
function subscriptionOptions<T extends RequestHooks>(options?: T) {
  return {
    ...options,
    maxRetries: 0,
    async onPayload(payload: unknown, model: Model<Api>) {
      const changed = await options?.onPayload?.(payload, model);
      return chatgptPayload(changed ?? payload, model);
    },
    async onProviderStreamEvent(event: unknown, model: Model<Api>) {
      chatgptStreamEvent(event, model);
      await options?.onProviderStreamEvent?.(event, model);
    },
  };
}

/** The credential owner refreshes tokens; Pi receives only the current bearer token. */
export function chatgptProvider(connection: ChatGPTConnection): Provider<"openai-responses"> {
  const provider = openaiProvider();
  return {
    ...provider,
    auth: { apiKey: {
      name: "ChatGPT subscription",
      async resolve({ signal }) {
        signal.throwIfAborted();
        const access = await connection.getAccessToken();
        signal.throwIfAborted();
        return { auth: { apiKey: access }, source: "ChatGPT subscription" };
      },
    } },
    stream: (model, context, options) => provider.stream<"openai-responses">(model, context, subscriptionOptions(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, subscriptionOptions(options)),
  };
}

export function piModels(workersAI: Provider, connection: ChatGPTConnection) {
  const models = createModels();
  models.setProvider(workersAI);
  models.setProvider(chatgptProvider(connection));
  return models;
}

/** Existing Pi sessions retain their model. Apply explicit account selections on next use. */
export class PiModelSelection {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private harness: PiHarness,
    private connection: ChatGPTConnection,
    private fallback: Pick<Model<Api>, "provider" | "id">,
    private storage: Pick<DurableObjectStorage, "get" | "put">,
  ) {}

  sync(): Promise<string> {
    const operation = this.tail.then(async () => {
      const selection = await this.connection.getSelection();
      const model = selection.model ? { provider: "openai", id: selection.model } : this.fallback;
      const thinkingLevel = selection.model === "gpt-6.1-sol" ? "medium" : "low";
      const key = `${model.provider}:${model.id}:${thinkingLevel}`;
      const applied = await this.storage.get<string>("isobot:selected-model");
      if (applied !== key) {
        const conversation = await this.harness.conversation(this.harness.session().id);
        await conversation.configure({
          model: { provider: model.provider, modelId: model.id }, thinkingLevel,
        }, modelContext);
        await this.storage.put("isobot:selected-model", key);
      }
      return model.id;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
