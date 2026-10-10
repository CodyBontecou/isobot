import assert from "node:assert/strict";
import test from "node:test";
import type { UsageState } from "@earendil-works/pi-durable";
import { configuredResourceBindings, publishedPricing, summarizeResourceUsage } from "./resources.js";

const usage = (input: number, output: number, cached: number, total: number) => ({
  input, output, cacheRead: cached, cacheWrite: 0, totalTokens: input + output + cached,
  cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

test("resource usage includes persisted historical providers without calling catalog costs invoices", () => {
  const ledger: UsageState = {
    models: { "cloudflare/@cf/moonshotai/kimi-k2.7-code": usage(10, 20, 30, 0.25), "openai/gpt-6.1-sol": usage(40, 50, 60, 3) },
    tools: { research: usage(5, 6, 0, 0.1) },
  };
  const result = summarizeResourceUsage(ledger);
  assert.equal(result.scope, "assistant lifetime");
  assert.equal(result.inputTokens, 55);
  assert.equal(result.outputTokens, 76);
  assert.equal(result.cacheReadTokens, 90);
  assert.equal(result.totalTokens, 221);
  assert.equal(result.recordedCatalogEstimateUSD, 3.35);
  assert.equal(result.models.length, 2);
  assert.equal(result.models[1].key, "openai/gpt-6.1-sol");
  assert.equal("actualBill" in result, false);
});

test("published rates distinguish ChatGPT selection from Workers AI and disclose gross storage estimates", () => {
  const cloudflare = publishedPricing("@cf/moonshotai/kimi-k2.7-code", 1_000_000_000);
  assert.equal(cloudflare.model.inputPerMillion, 0.95);
  assert.equal(cloudflare.model.cachedInputPerMillion, 0.19);
  assert.equal(cloudflare.model.outputPerMillion, 4);
  assert.equal(cloudflare.actualBill, null);
  assert.equal(cloudflare.storageEstimateUSDPerMonth, 0.20);
  assert.ok(cloudflare.rates.every(rate => rate.source.startsWith("https://developers.cloudflare.com/")));
  assert.ok(cloudflare.notes.some(note => note.includes("before included allowances")));
  const chatgpt = publishedPricing("gpt-6.1-sol", 0);
  assert.match(chatgpt.model.label, /subscription/);
  assert.equal(chatgpt.model.inputPerMillion, undefined);
  assert.equal(chatgpt.model.outputPerMillion, undefined);
  assert.equal(publishedPricing("@cf/another-model", 0).model.inputPerMillion, undefined);
});

test("resource bindings expose configured public resources without serializing credential values", () => {
  const env = { AI: {}, Assistant: {}, ChatGPTAuth: {}, AccountAuth: {}, ASSETS: {},
    GITHUB_TOKEN: "secret-github-token", PROMPT_API_TOKEN: "secret-api-token" };
  const result = configuredResourceBindings(env);
  assert.deepEqual(result.map(binding => binding.name), ["AI", "Assistant", "ChatGPTAuth", "AccountAuth", "ASSETS"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("TOKEN"), false);
});
