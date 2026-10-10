import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const root =
  process.env.ISOBOT_ROOT ?? new URL("../", import.meta.url).pathname;
const require = createRequire(join(root, "cloudflare/package.json"));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

for (const [repository, ref] of [
  ["CodyBontecou/myself.md", "main"],
  ["ExampleOrg/another-app", "develop"],
]) {
  test(`support issues and Codex dispatch use ${repository} at ${ref}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "support-repository-"));
    await build({
      stdin: {
        contents: `
        import {DurableObject} from 'cloudflare:workers';
        import {SupportAccount as Base,SupportDirectory,handleSupportRequest,digest} from './support-service.ts';
        export {SupportDirectory};
        const requests=[];
        globalThis.fetch=async (url,options)=>{
          requests.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});
          if(options.method==='GET')return Response.json([]);
          if(url.endsWith('/issues'))return Response.json({number:123,html_url:url.replace('api.github.com/repos','github.com')+'/123'});
          if(url.endsWith('/dispatches'))return new Response(null,{status:204});
          throw new Error('Unexpected outbound request');
        };
        export class SupportAccount extends Base {
          async runAlarm(){await this.alarm();}
        }
        export class SupportTurn extends DurableObject {
          async purge(){}
          async start(){return {accepted:true}}
          async status(){return {status:'done',text:'fixture'}}
        }
        export default {async fetch(request,env){
          const path=new URL(request.url).pathname;
          if(path==='/requests')return Response.json(requests);
          if(path==='/action'){
            const input=await request.json();
            return Response.json(await env.SupportAccount.getByName('myself-'+await digest('fixture-owner')).agentAction({account:'myself-'+await digest('fixture-owner'),id:'conversation',generation:1},input.action,input));
          }
          if(path==='/alarm'){await env.SupportAccount.getByName('myself-'+await digest('fixture-owner')).runAlarm();return Response.json({saved:true});}
          return handleSupportRequest(request,env);
        }};`,
        resolveDir: join(root, "cloudflare/src"),
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd"],
      external: ["cloudflare:*", "node:*"],
      outfile: join(directory, "worker.mjs"),
    });
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: "support-repository",
            modules: true,
            scriptPath: join(directory, "worker.mjs"),
            modulesRoot: directory,
            compatibilityDate: "2026-10-07",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: {
              SupportAccount: { className: "SupportAccount", useSQLite: true },
              SupportDirectory: {
                className: "SupportDirectory",
                useSQLite: true,
              },
              SupportTurn: { className: "SupportTurn", useSQLite: true },
            },
            bindings: {
              SUPPORT_GITHUB_REPOSITORY: repository,
              SUPPORT_GITHUB_REF: ref,
              SUPPORT_SERVICE_TOKEN: "fixture",
              SUPPORT_TASK_TOKEN: "task-fixture",
              GITHUB_TOKEN: "fixture",
            },
          },
        ],
      }),
    );
    const call = async (path, body, token = "fixture") => {
      const response = await runtime.dispatchFetch("https://fixture" + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "X-Support-Owner": "fixture-owner",
          "X-Support-Role": "owner",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      assert.equal(
        (
          await call("/api/support/v1", {
            action: "create",
            id: "conversation",
            title: "Fixture bug",
          })
        ).status,
        200,
      );
      const ticket = await call("/action", {
        action: "ticket",
        title: "Fixture bug",
        body: "Sanitized reproduction",
      });
      assert.equal(
        ticket.body.url,
        `https://github.com/${repository}/issues/123`,
      );
      const queued = await call("/action", {
        action: "codex",
        title: "Fixture bug",
        instructions: "Acceptance criteria",
      });
      assert.equal(queued.body.repository, repository);
      await call("/alarm", {});
      const requests = await (
        await runtime.dispatchFetch("https://fixture/requests")
      ).json();
      const dispatch = requests.find((r) => r.url.endsWith("/dispatches"));
      assert.equal(
        dispatch.url,
        `https://api.github.com/repos/${repository}/actions/workflows/support-codex.yml/dispatches`,
      );
      assert.equal(dispatch.body.ref, ref);
      const context = {
        account: dispatch.body.inputs.account,
        conversationId: "conversation",
        generation: 1,
        id: queued.body.id,
        status: "completed",
      };
      const rejected = await call(
        "/api/support-bridge/task",
        {
          ...context,
          url: "https://github.com/CodyBontecou/support-chat/pull/123",
        },
        "task-fixture",
      );
      assert.notEqual(rejected.status, 200);
      assert.equal(
        (
          await call(
            "/api/support-bridge/task",
            { ...context, url: `https://github.com/${repository}/pull/123` },
            "wrong-token",
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await call(
            "/api/support-bridge/task",
            { ...context, url: `https://github.com/${repository}/pull/123` },
            "task-fixture",
          )
        ).status,
        200,
      );
    } finally {
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
