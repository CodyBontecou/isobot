import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

// Use the real Workers SQLite/RPC implementation, including a full runtime restart.
test("pending delivery and acknowledged tombstones survive runtime restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-inbox-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import { DeliveryInbox } from './delivery.ts';
        export { DeliveryInbox };
        export default { async fetch(request, env) {
          const inbox = env.Inbox.getByName('discord');
          const path = new URL(request.url).pathname;
          if (path === '/remember') return Response.json(await inbox.remember(await request.json()));
          if (path === '/delivered') { await inbox.delivered(await request.text()); return new Response(null, {status:204}); }
          return Response.json(await inbox.pending());
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "inbox-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], outfile: bundle,
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{
      name: "isobot-delivery-test", modules: true, scriptPath: bundle,
      // The v5 adapter names modules relative to this root; avoid ../ paths from the temporary bundle.
      modulesRoot: directory,
      compatibilityDate: "2026-10-07",
      durableObjects: { Inbox: { className: "DeliveryInbox", useSQLite: true } },
    }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  try {
    const original = { eventId: "1557402530611200000", context: { message: "original" } };
    const remember = async (input: unknown) => (await runtime.dispatchFetch("http://test/remember", { method: "POST", body: JSON.stringify(input) })).json();
    assert.deepEqual(await remember(original), { ticket: original, delivered: false });
    assert.deepEqual(await remember({ ...original, context: { message: "changed" } }), { ticket: original, delivered: false });
    assert.deepEqual(await (await runtime.dispatchFetch("http://test/pending")).json(), [original]);
    await runtime.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    assert.deepEqual(await (await runtime.dispatchFetch("http://test/pending")).json(), [original]);
    assert.equal((await runtime.dispatchFetch("http://test/delivered", { method: "POST", body: original.eventId })).status, 204);
    await runtime.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    assert.deepEqual(await remember(original), { ticket: original, delivered: true });
    assert.deepEqual(await (await runtime.dispatchFetch("http://test/pending")).json(), []);
    // An inaccessible batch must not monopolize recovery of newer tickets.
    for (let i = 0; i < 101; i++) await remember({ eventId: String(i), context: { message: "queued" } });
    const first = await (await runtime.dispatchFetch("http://test/pending")).json() as { eventId: string }[];
    assert.equal(first.length, 100);
    const second = await (await runtime.dispatchFetch("http://test/pending")).json() as { eventId: string }[];
    assert.equal(second[0].eventId, "100");
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
