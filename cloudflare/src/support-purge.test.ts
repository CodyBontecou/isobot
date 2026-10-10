import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import {
  Miniflare,
  convertV4MiniflareOptions,
  type V4MiniflareOptions,
} from "miniflare";

test("production Pi purge erases durable data and prevents resurrection after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-purge-")),
    bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `
    import {DurableObject} from 'cloudflare:workers';
    import {SupportTurn} from './support-agent.ts';
    export class ProbeTurn extends SupportTurn {
      async permissions(role){
        await this.configureTools(role);
        const conversation=await this.harness.conversation(this.harness.session().id);
        const agent=await conversation.agent({abortSignal:undefined,value:()=>undefined,toString:()=> 'fixture'});
        return agent.tools.map(tool=>tool.name);
      }
      async seed(){await this.ctx.storage.put('private-test','private fixture attachment');this.ctx.storage.sql.exec('CREATE TABLE fixture_private (value TEXT); INSERT INTO fixture_private VALUES (?)','private fixture attachment')}
      async inspect(){return {keys:[...(await this.ctx.storage.list()).keys()],privateTable:this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='fixture_private'").toArray(),input:this.state.input};}
    }
    export class FakeAuth extends DurableObject {
      getSelection(){return {model:null,revision:0}}
    }
    export default {async fetch(request,env){
      const t=env.SupportTurn.getByName('purge-fixture'),path=new URL(request.url).pathname;
      if(path==='/permissions') return Response.json(await t.permissions(new URL(request.url).searchParams.get('role')));
      if(path==='/seed'){await t.seed();return Response.json({saved:true})}
      if(path==='/purge'){await t.purge();return Response.json({purged:true})}
      if(path==='/start'){try{await t.start({});return Response.json({accepted:true})}catch{return Response.json({retired:true},{status:409})}}
      return Response.json(await t.inspect());
    }};`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "purge-fixture.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd"],
    external: ["cloudflare:*", "node:*", "path"],
    outfile: bundle,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.mjs');",
    },
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [
      {
        name: "purge-test",
        modules: true,
        scriptPath: bundle,
        modulesRoot: directory,
        compatibilityDate: "2026-10-07",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: { AI: "blocked-ai" },
        durableObjects: {
          SupportTurn: { className: "ProbeTurn", useSQLite: true },
          ChatGPTAuth: { className: "FakeAuth", useSQLite: true },
        },
        bindings: {
          PI_MODEL: "@cf/moonshotai/kimi-k2.7-code",
          SUPPORT_GITHUB_REPOSITORY: "CodyBontecou/myself.md",
          SUPPORT_GITHUB_REF: "main",
        },
      },
      {
        name: "blocked-ai",
        modules: true,
        script:
          'export default {fetch(){throw new Error("Inference is forbidden in this fixture")}};',
      },
    ],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  try {
    for (const [role, names] of [
      [
        "owner",
        [
          "read_app_help",
          "request_support_data",
          "read_support_attachment",
          "read_app_source",
          "create_support_ticket",
          "dispatch_support_codex",
        ],
      ],
      ["lifetime", ["read_app_help", "create_support_ticket"]],
      ["guest", ["read_app_help", "create_support_ticket"]],
    ] as const) {
      const response = await runtime.dispatchFetch(
        `https://test/permissions?role=${role}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), names);
    }
    const seeded = await runtime.dispatchFetch("https://test/seed");
    assert.equal(seeded.status, 200, await seeded.text());
    const purge = await runtime.dispatchFetch("https://test/purge");
    assert.equal(purge.status, 200, await purge.text());
    const clean = (await (
      await runtime.dispatchFetch("https://test/inspect")
    ).json()) as { keys: string[]; privateTable: unknown[]; input: unknown };
    assert.deepEqual(clean.keys, ["retired"]);
    assert.deepEqual(clean.privateTable, []);
    assert.equal(clean.input, null);
    await runtime.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    assert.equal(
      (await runtime.dispatchFetch("https://test/start")).status,
      409,
    );
    const restored = (await (
      await runtime.dispatchFetch("https://test/inspect")
    ).json()) as { privateTable: unknown[]; input: unknown };
    assert.deepEqual(restored.privateTable, []);
    assert.equal(restored.input, null);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
