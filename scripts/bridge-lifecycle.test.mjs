import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from '../bridge/node_modules/esbuild/lib/main.js';

test('bridge stays a singleton, recovers, rolls out images, and protects lifecycle controls', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'isobot-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, 'worker.mjs');
  await build({
    entryPoints: [new URL('../bridge/src/index.ts', import.meta.url).pathname],
    outfile: bundle, bundle: true, format: 'esm', platform: 'node',
    plugins: [{ name: 'cloudflare-base', setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'base', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }' }));
    } }],
  });
  const { DiscordBridge, default: worker } = await import(pathToFileURL(bundle).href);
  const saved = new Map();
  let running = false, started = 0, stopped = 0, alarm = null, image = null;
  const container = {
    images: { base: 'image-v1' },
    get running() { return running; },
    async inspect() { return running ? { image } : null; },
    async setInactivityTimeout() { assert.ok(running, "inactivity timeout requires a started container"); },
    start(options) { assert.equal(running, false); assert.equal(options.env.DISCORD_BOT_TOKEN, 'fixture'); running = true; image = options.image; started++; },
    async destroy() { running = false; image = null; stopped++; },
    getTcpPort(port) { assert.equal(port, 8080); return { async fetch() { assert.ok(running); return Response.json({ ok: true }); } }; },
  };
  const ctx = { container, storage: {
    async get(key) { return saved.get(key); },
    async put(key, value) { saved.set(key, value); },
    async setAlarm(value) { alarm = value; },
    async deleteAlarm() { alarm = null; },
  } };
  const env = { DISCORD_BOT_TOKEN: 'fixture', ISOBOT_API_TOKEN: 'test-secret' };
  const bridge = new DiscordBridge(ctx, env);
  env.BRIDGE = { getByName(name) { assert.equal(name, 'production'); return bridge; } };
  const health = () => worker.fetch(new Request('https://bridge/health'), env);
  await Promise.all([health(), health(), worker.scheduled({}, env)]);
  assert.equal(started, 1);
  assert.ok(alarm > Date.now());
  // A process exit is recovered by the persisted alarm.
  running = false;
  await bridge.alarm();
  assert.equal(started, 2);
  // Deploying a new image replaces the old process before starting another.
  container.images.base = 'image-v2';
  await health();
  assert.equal(started, 3);
  assert.equal(stopped, 1);
  const admin = (action, token) => worker.fetch(new Request(`https://bridge/admin/${action}`, {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
  }), env);
  const deniedRead=await worker.fetch(new Request('https://bridge/api/discord/channels'),env);
  assert.equal(deniedRead.status,401);
  const allowedRead=await worker.fetch(new Request('https://bridge/api/discord/channels',{headers:{Authorization:'Bearer test-secret'}}),env);
  assert.equal(allowedRead.status,200);
  assert.equal((await admin('pause')).status, 401);
  assert.equal(running, true);
  assert.equal((await admin('pause', 'test-secret')).status, 200);
  assert.equal(running, false);
  assert.equal(alarm, null);
  await worker.scheduled({}, env);
  assert.equal(started, 3);
  assert.equal((await health()).status, 503);
  assert.equal((await admin('resume', 'test-secret')).status, 200);
  assert.equal(started, 4);
  assert.equal((await admin('restart', 'test-secret')).status, 200);
  assert.equal(started, 5);
  assert.equal((await worker.fetch(new Request('https://bridge/unknown'), env)).status, 404);
});
