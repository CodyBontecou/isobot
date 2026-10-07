import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";
import { isPromptRequest } from "./prompt.js";

test("accepts prompts with optional conversation and retry ids", () => {
  assert.equal(isPromptRequest({ prompt: "Hello" }), true);
  assert.equal(isPromptRequest({ prompt: " Hello ", conversation: "project_1", requestId: "a-b" }), true);
  assert.equal(isPromptRequest({ prompt: "x".repeat(16_000), conversation: "a".repeat(100), requestId: "d777771f-b261-407b-8cfe-ce735a57034c" }), true);
});

test("rejects invalid prompts and ambiguous or unsafe identifiers", () => {
  for (const value of [null, [], "hello", {}, { prompt: 42 }, { prompt: "" }, { prompt: " \n\t" }, { prompt: "x".repeat(16_001) }]) {
    assert.equal(isPromptRequest(value), false);
  }
  for (const field of ["conversation", "requestId"]) {
    for (const value of [null, undefined, 42, "", "a".repeat(101), "../other", "a/b", "a b", "ü", "a\n"]) {
      assert.equal(isPromptRequest({ prompt: "Hello", [field]: value }), false, `${field}: ${String(value)}`);
    }
  }
});

test("prompt reservations reject conflicts and survive concurrent calls and runtime restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-prompt-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import { DurableObject } from 'cloudflare:workers';
        import { initializePromptRequests, reservePrompt } from './prompt.ts';
        export class PromptGuard extends DurableObject {
          constructor(ctx, env) { super(ctx, env); initializePromptRequests(ctx.storage.sql); }
          async reserve(input) { return reservePrompt(this.ctx.storage.sql, input.requestId, input.prompt); }
        }
        export default { async fetch(request, env) {
          return Response.json(await env.Prompts.getByName('conversation').reserve(await request.json()));
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "prompt-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], outfile: bundle,
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{
      name: "isobot-prompt-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07",
      durableObjects: { Prompts: { className: "PromptGuard", useSQLite: true } },
    }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const reserve = async (requestId: string, prompt: string): Promise<boolean> => {
    const response = await runtime.dispatchFetch("http://test/reserve", {
      method: "POST", body: JSON.stringify({ requestId, prompt }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(typeof result === "boolean");
    return result;
  };
  try {
    assert.equal(await reserve("stable", "original"), true);
    assert.equal(await reserve("stable", "original"), true);
    assert.equal(await reserve("stable", "changed"), false);
    assert.equal(await reserve("different", "changed"), true);

    const candidates = ["first", "second", "first", "second"];
    const results = await Promise.all(candidates.map(prompt => reserve("concurrent", prompt)));
    const admitted = candidates[results.indexOf(true)];
    assert.ok(admitted);
    assert.deepEqual(results, candidates.map(prompt => prompt === admitted));

    await runtime.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    assert.equal(await reserve("stable", "original"), true);
    assert.equal(await reserve("stable", "changed"), false);
    assert.equal(await reserve("concurrent", admitted), true);
    assert.equal(await reserve("concurrent", admitted === "first" ? "second" : "first"), false);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
