import assert from "node:assert/strict";
import { test } from "node:test";
import { pingHeartbeat } from "./ops.js";

test("the external heartbeat pings with POST and never throws", async () => {
  const seen: string[] = [];
  const ok = (async (url: string, init?: RequestInit) => { seen.push(`${init?.method} ${url}`); return new Response("OK"); }) as typeof fetch;
  assert.equal(await pingHeartbeat("https://hc.example/ping/abc", ok), true);
  assert.deepEqual(seen, ["POST https://hc.example/ping/abc"]);
  assert.equal(await pingHeartbeat("https://hc.example/x", (async () => new Response("no", { status: 404 })) as typeof fetch), false);
  assert.equal(await pingHeartbeat("https://hc.example/x", (async () => { throw new Error("offline"); }) as typeof fetch), false);
});
