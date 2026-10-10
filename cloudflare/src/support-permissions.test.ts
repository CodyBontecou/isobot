import assert from "node:assert/strict";
import { test } from "node:test";
import { canUseSupportTool, supportRole } from "./support-permissions.js";

test("support grants only known tools to the developer and ticket creation to customers and guests", () => {
  const tools = [
    "read_app_help",
    "request_support_data",
    "read_support_attachment",
    "read_app_source",
    "create_support_ticket",
    "dispatch_support_codex",
  ];
  for (const tool of tools) {
    assert.equal(canUseSupportTool("owner", tool), true);
    assert.equal(
      canUseSupportTool("lifetime", tool),
      ["read_app_help", "create_support_ticket"].includes(tool),
    );
    assert.equal(
      canUseSupportTool("guest", tool),
      ["read_app_help", "create_support_ticket"].includes(tool),
    );
  }
  for (const role of ["owner", "lifetime", "guest"] as const)
    assert.equal(canUseSupportTool(role, "arbitrary_new_tool"), false);
  for (const untrusted of [undefined, null, "admin", { role: "owner" }])
    assert.equal(supportRole(untrusted), "guest");
});
