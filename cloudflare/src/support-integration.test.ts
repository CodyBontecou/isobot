import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import {
  Miniflare,
  convertV4MiniflareOptions,
  type V4MiniflareOptions,
} from "miniflare";

test("support ownership, snapshot approval, retry identity and archive cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-support-")),
    bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `
    import {DurableObject} from 'cloudflare:workers';
    import {SupportAccount as BaseSupportAccount,SupportDirectory,handleSupportRequest,digest} from './support-service.ts';
    export {SupportDirectory};
    export class SupportAccount extends BaseSupportAccount {
      async github(path,method,body){
        if(method==='GET') return [];
        if(path!=='/issues'||method!=='POST') throw new Error('Unexpected GitHub fixture action');
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO support_meta VALUES ('fixture-ticket',?)",JSON.stringify(body));
        return {number:123,html_url:'https://github.com/CodyBontecou/support-chat/issues/123'};
      }
      async expireRole(){this.ctx.storage.sql.exec("INSERT OR REPLACE INTO support_meta VALUES ('role',?)",JSON.stringify({role:'owner',expiresAt:0}));}
      async inspectJobs(){return this.ctx.storage.sql.exec('SELECT value FROM support_jobs').toArray().map(row=>JSON.parse(row.value));}
    }
    export class SupportTurn extends DurableObject {
      async purge(){await this.ctx.storage.deleteAll()}
      async start(){return {accepted:true}}
      async status(){return {status:'done',text:'fixture reply'}}
    }
    export default {async fetch(request,env){
      const u=new URL(request.url);
      if(u.pathname==='/__jobs'){
        const input=await request.json();return Response.json(await env.SupportAccount.getByName('myself-'+await digest(input.owner)).inspectJobs());
      }
      if(u.pathname==='/__expire'){
        const input=await request.json();await env.SupportAccount.getByName('myself-'+await digest(input.owner)).expireRole();return Response.json({expired:true});
      }
      if(u.pathname==='/__authorize'){
        const input=await request.json();const account='myself-'+await digest(input.owner);
        const service=env.SupportAccount.getByName(account);
        try {await service.authorizeTool({account,id:input.conversationId,generation:input.generation},input.tool);return Response.json({allowed:true})}
        catch{return Response.json({allowed:false},{status:403})}
      }
      if(u.pathname==='/__ticket'){
        const input=await request.json(),account='myself-'+await digest(input.owner);
        try{return Response.json(await env.SupportAccount.getByName(account).agentAction({account,id:'role-conversation',generation:1},'ticket',{title:'Guest bug report',body:'Reproduction steps'}))}
        catch(e){return Response.json({error:e.message},{status:403})}
      }
      if(u.pathname==='/__read_attachment'){
        const input=await request.json();const account='myself-'+await digest(input.owner);
        try{return Response.json(await env.SupportAccount.getByName(account).agentAction({account,id:input.conversationId,generation:input.generation},'attachment',{id:input.id}))}
        catch{return Response.json({unavailable:true},{status:404})}
      }
      return handleSupportRequest(request,env);
    }};`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "support-fixture.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd"],
    external: ["cloudflare:*", "node:*"],
    outfile: bundle,
  });
  const options: V4MiniflareOptions = {
    workers: [
      {
        name: "support-test",
        modules: true,
        scriptPath: bundle,
        modulesRoot: directory,
        compatibilityDate: "2026-10-07",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          SupportAccount: { className: "SupportAccount", useSQLite: true },
          SupportDirectory: { className: "SupportDirectory", useSQLite: true },
          SupportTurn: { className: "SupportTurn", useSQLite: true },
        },
        bindings: {
          SUPPORT_GITHUB_REPOSITORY: "CodyBontecou/support-chat",
          SUPPORT_GITHUB_REF: "main",
          GITHUB_TOKEN: "fixture-token",
          SUPPORT_SERVICE_TOKEN: "test-service",
          SUPPORT_BRIDGE_TOKEN: "test-bridge",
          SUPPORT_ENCRYPTION_KEY: "ab".repeat(32),
        },
      },
    ],
  };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  const call = (owner: string, body: unknown, agent?: string) =>
    runtime.dispatchFetch("https://test/api/support/v1", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-service",
        "X-Support-Owner": owner,
        "X-Support-Role": "owner",
        "Content-Type": "application/json",
        ...(agent ? { "X-Support-Agent": agent } : {}),
      },
      body: JSON.stringify(body),
    });
  async function ok(owner: string, body: unknown) {
    const r = await call(owner, body);
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()) as Record<string, unknown>;
  }
  const id = "conversation-a",
    second = "conversation-b";
  try {
    await t.test(
      "host-asserted roles allow guest tickets but block customer diagnostics, including revocation",
      async () => {
        const owner = "role-fixture";
        const roleCall = (role: string, body: unknown, subject = owner) =>
          runtime.dispatchFetch("https://test/api/support/v1", {
            method: "POST",
            headers: {
              Authorization: "Bearer test-service",
              "X-Support-Owner": subject,
              "X-Support-Role": role,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
        const authorize = (tool: string, subject = owner) =>
          runtime.dispatchFetch("https://test/__authorize", {
            method: "POST",
            body: JSON.stringify({
              owner: subject,
              conversationId: "role-conversation",
              generation: 1,
              tool,
            }),
          });
        assert.equal(
          (
            await roleCall("guest", {
              action: "create",
              id: "role-conversation",
              title: "App question",
            })
          ).status,
          200,
        );
        assert.equal((await authorize("read_app_help")).status, 200);
        assert.equal((await authorize("create_support_ticket")).status, 200);
        assert.equal(
          (
            await roleCall("lifetime", {
              action: "read",
              conversationId: "role-conversation",
            })
          ).status,
          200,
        );
        assert.equal((await authorize("create_support_ticket")).status, 200);
        for (const tool of [
          "read_app_source",
          "read_support_attachment",
          "request_support_data",
          "dispatch_support_codex",
        ])
          assert.equal((await authorize(tool)).status, 403);
        assert.equal(
          (
            await roleCall("lifetime", {
              action: "share",
              conversationId: "role-conversation",
            })
          ).status,
          403,
        );
        await roleCall("owner", {
          action: "read",
          conversationId: "role-conversation",
        });
        assert.equal((await authorize("dispatch_support_codex")).status, 200);
        await runtime.dispatchFetch("https://test/__expire", {
          method: "POST",
          body: JSON.stringify({ owner }),
        });
        assert.equal((await authorize("create_support_ticket")).status, 200);
        assert.equal((await authorize("read_app_help")).status, 200);
        await roleCall("guest", {
          action: "read",
          conversationId: "role-conversation",
        });
        assert.equal((await authorize("dispatch_support_codex")).status, 403);
        assert.equal((await authorize("create_support_ticket")).status, 200);
        const guest = "support-guest:fixture";
        await roleCall(
          "owner",
          {
            action: "create",
            id: "role-conversation",
            title: "Guest question",
          },
          guest,
        );
        assert.equal((await authorize("read_app_help", guest)).status, 200);
        assert.equal(
          (await authorize("create_support_ticket", guest)).status,
          200,
        );
        assert.equal(
          (await authorize("dispatch_support_codex", guest)).status,
          403,
        );
        assert.equal((await authorize("read_app_source", guest)).status, 403);
        const ticketRequest = () =>
          runtime.dispatchFetch("https://test/__ticket", {
            method: "POST",
            body: JSON.stringify({ owner: guest }),
          });
        const created = await ticketRequest();
        assert.equal(created.status, 200);
        assert.equal(
          ((await created.json()) as { url: string }).url,
          "https://github.com/CodyBontecou/support-chat/issues/123",
        );
        assert.deepEqual(await (await ticketRequest()).json(), {
          number: 123,
          repository: "CodyBontecou/support-chat",
          url: "https://github.com/CodyBontecou/support-chat/issues/123",
        });

        // This extra fixture conversation must not alter later bridge-job counts.
        await roleCall("guest", {
          action: "delete",
          conversationId: "role-conversation",
        });
        await roleCall(
          "guest",
          { action: "delete", conversationId: "role-conversation" },
          guest,
        );
      },
    );
    await t.test(
      "service authentication is independent of console and bridge tokens",
      async () => {
        assert.equal(
          (
            await runtime.dispatchFetch("https://test/api/support/v1", {
              method: "POST",
              body: "{}",
            })
          ).status,
          401,
        );
      },
    );
    await t.test(
      "creation sends the title once and queues Pi and Discord",
      async () => {
        const owner = "initial-prompt-fixture",
          title = "I should be able to send an image to isobot";
        const input = { action: "create", id: "initial-prompt", title };
        const created = await ok(owner, input);
        assert.deepEqual(created.messages, [
          {
            id: input.id,
            sequence: 1,
            author: "user",
            text: title,
            createdAt: (created.messages as { createdAt: string }[])[0]
              ?.createdAt,
          },
        ]);
        await ok(owner, input);
        const read = await ok(owner, {
          action: "read",
          conversationId: input.id,
        });
        assert.equal(
          (read.messages as { author: string }[]).filter(
            (m) => m.author === "user",
          ).length,
          1,
        );
        const jobs = await runtime.dispatchFetch("https://test/__jobs", {
          method: "POST",
          body: JSON.stringify({ owner }),
        });
        const queued = (await jobs.json()) as {
          kind: string;
          payload: string;
        }[];
        assert.equal(queued.filter((j) => j.kind === "pi").length, 1);
        assert.equal(queued.filter((j) => j.kind === "discord").length, 1);
        assert.equal(
          JSON.parse(queued.find((j) => j.kind === "discord")!.payload).text,
          title,
        );
      },
    );
    await t.test(
      "two accounts and multiple conversations are isolated",
      async () => {
        await ok("alice", { action: "create", id, title: "Export issue" });
        await ok("alice", {
          action: "update",
          conversationId: id,
          autoReply: false,
        });
        await ok("alice", {
          action: "create",
          id: second,
          title: "Usage question",
        });
        await ok("alice", {
          action: "update",
          conversationId: second,
          autoReply: false,
        });
        assert.equal(
          (await call("bob", { action: "read", conversationId: id })).status,
          404,
        );
        assert.equal(
          (await call("alice", { action: "read", conversationId: id }, "agent"))
            .status,
          403,
        );
        await ok("alice", {
          action: "send",
          conversationId: id,
          id: "message-a",
          text: "Export failed",
        });
        await ok("alice", {
          action: "send",
          conversationId: id,
          id: "message-a",
          text: "Export failed",
        });
        assert.equal(
          (
            await call("alice", {
              action: "send",
              conversationId: id,
              id: "message-a",
              text: "Changed payload",
            })
          ).status,
          409,
        );
        const a = await ok("alice", { action: "read", conversationId: id }),
          b = await ok("alice", { action: "read", conversationId: second });
        assert.equal((a.messages as unknown[]).length, 2);
        assert.equal((b.messages as unknown[]).length, 1);
      },
    );
    await t.test(
      "approval is scoped to an exact snapshot and agents cannot approve",
      async () => {
        const now = Date.now();
        await ok("alice", {
          action: "request",
          conversationId: id,
          id: "request-a",
          reason: "Inspect export failures",
          selector: { category: "logs", from: now - 86400000, to: now },
        });
        const content = '  {"sensitive":"fixture only"}\n',
          digest = createHash("sha256").update(content).digest("hex");
        const input = {
          action: "share",
          conversationId: id,
          generation: 2,
          id: "attachment-a",
          requestId: "request-a",
          category: "logs",
          capturedAt: now,
          content,
          digest,
        };
        assert.equal((await call("alice", input)).status, 403);
        assert.equal(
          (await call("alice", { ...input, accepted: true, digest: "wrong" }))
            .status,
          409,
        );
        await ok("alice", {
          action: "update",
          conversationId: id,
          agentAccess: true,
        });
        assert.equal(
          (await call("alice", { ...input, accepted: true }, "agent")).status,
          403,
        );
        await ok("alice", { ...input, accepted: true });
        await ok("alice", { ...input, accepted: true });
        const c = await ok("alice", { action: "read", conversationId: id });
        assert.equal((c.attachments as unknown[]).length, 1);
        const r = await runtime.dispatchFetch(
          "https://test/__read_attachment",
          {
            method: "POST",
            body: JSON.stringify({
              owner: "alice",
              conversationId: id,
              generation: 2,
              id: "attachment-a",
            }),
          },
        );
        assert.equal(r.status, 200);
        assert.equal(((await r.json()) as { text: string }).text, content);
      },
    );
    await t.test(
      "archive preserves text, deletes data, and fences stale uploads",
      async () => {
        await ok("alice", { action: "archive", conversationId: id });
        const c = await ok("alice", { action: "read", conversationId: id });
        assert.equal(c.status, "archived");
        assert.equal((c.messages as unknown[]).length, 2);
        assert.equal(
          (c.attachments as { removed: boolean }[])[0].removed,
          true,
        );
        assert.equal(
          (await call("alice", { action: "create", id, title: "Export issue" }))
            .status,
          409,
        );
        const r = await runtime.dispatchFetch(
          "https://test/__read_attachment",
          {
            method: "POST",
            body: JSON.stringify({
              owner: "alice",
              conversationId: id,
              generation: 2,
              id: "attachment-a",
            }),
          },
        );
        assert.equal(r.status, 404);
        await ok("alice", {
          action: "update",
          conversationId: id,
          status: "open",
        });
        assert.equal(
          (
            await call("alice", {
              action: "share",
              conversationId: id,
              generation: 2,
              accepted: true,
            })
          ).status,
          409,
        );
        await ok("alice", { action: "delete", conversationId: id });
        assert.equal(
          (await call("alice", { action: "create", id, title: "Export issue" }))
            .status,
          409,
        );
        assert.equal(
          (await call("alice", { action: "read", conversationId: id })).status,
          404,
        );
      },
    );
    await t.test(
      "staff takeover and replay preserve owner resume",
      async () => {
        const account =
          "myself-" + createHash("sha256").update("alice").digest("hex");
        const bridge = (path: string, body: unknown) =>
          runtime.dispatchFetch(`https://test/api/support-bridge/${path}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer test-bridge",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
        await ok("alice", {
          action: "send",
          conversationId: second,
          id: "message-b",
          text: "A separate issue",
        });
        await ok("alice", {
          action: "update",
          conversationId: second,
          autoReply: true,
        });
        assert.equal(
          (
            await bridge("ack", {
              account,
              conversationId: second,
              id: "discord-message-b",
              threadId: "thread-b",
            })
          ).status,
          200,
        );
        const body = {
          threadId: "thread-b",
          id: "staff-message",
          text: "I will take a look",
        };
        assert.equal((await bridge("event", body)).status, 200);
        let c = await ok("alice", { action: "read", conversationId: second });
        assert.equal(c.autoReply, false);
        await ok("alice", {
          action: "update",
          conversationId: second,
          autoReply: true,
        });
        assert.equal((await bridge("event", body)).status, 200);
        c = await ok("alice", { action: "read", conversationId: second });
        assert.equal(c.autoReply, true);
        assert.equal(
          (c.messages as { id: string }[]).filter(
            (m) => m.id === "staff-staff-message",
          ).length,
          1,
        );
      },
    );
    await t.test(
      "agents cannot change owner preferences through read cursors",
      async () => {
        await ok("alice", {
          action: "update",
          conversationId: second,
          agentAccess: true,
        });
        assert.equal(
          (
            await call(
              "alice",
              {
                action: "readCursor",
                conversationId: second,
                readThrough: 0,
                agentAccess: false,
                autoReply: false,
              },
              "agent",
            )
          ).status,
          200,
        );
        const c = await ok("alice", { action: "read", conversationId: second });
        assert.equal(c.agentAccess, true);
        assert.equal(c.autoReply, true);
        assert.equal(
          (
            await call(
              "alice",
              { action: "create", id: "agent-created", title: "New issue" },
              "agent",
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              "alice",
              { action: "read", conversationId: "agent-created" },
              "agent",
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "account deletion blocks recreation and clears remaining conversations",
      async () => {
        await ok("alice", { action: "deleteAccount" });
        assert.equal(
          (
            await call("alice", {
              action: "create",
              id: "new",
              title: "Attempt",
            })
          ).status,
          410,
        );
        const b = await ok("bob", { action: "list" });
        assert.deepEqual(b.conversations, []);
      },
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
