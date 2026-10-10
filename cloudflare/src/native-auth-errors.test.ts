import assert from "node:assert/strict";
import test from "node:test";
import { handleAccountRequest, type AccountEnvironment } from "./account-routes.js";
import type { OAuthFlow } from "./account-store.js";

const origin = "https://native.test";
const state = "s".repeat(43);

test("expired native flows and lost-state markers return only the fixed error callback", async () => {
  const unreachable = async () => { throw new Error("Unexpected auth operation"); };
  const cases: { flow: OAuthFlow | null; marker: boolean; location: string }[] = [
    { flow: { codeVerifier: "v".repeat(43), returnTo: "/console", nativeCodeChallenge: "c".repeat(43), expiresAt: Date.now() - 1 },
      marker: false, location: "isobot://auth?error=invalid_state" },
    { flow: null, marker: true, location: "isobot://auth?error=invalid_state" },
    { flow: { codeVerifier: "v".repeat(43), returnTo: "/console", expiresAt: Date.now() - 1 },
      marker: true, location: "/console?authError=invalid_state" },
  ];
  for (const scenario of cases) {
    const env: AccountEnvironment = {
      AUTH_ORIGIN: origin, GITHUB_OAUTH_CLIENT_ID: "synthetic-client", GITHUB_OAUTH_CLIENT_SECRET: "synthetic-secret",
      GITHUB_OAUTH_ALLOWED_IDS: "42", AccountAuth: { getByName() { return {
        createFlow: unreachable, consumeFlow: async () => scenario.flow, upsertAccount: unreachable,
        createSession: unreachable, validateSession: unreachable, revokeSession: unreachable,
        createApiToken: unreachable, validateApiToken: unreachable, listApiTokens: unreachable, revokeApiToken: unreachable,
      }; } },
    };
    const response = await handleAccountRequest(new Request(`${origin}/auth/github/callback?state=${state}&code=unused`, {
      headers: { Cookie: `__Host-isobot_oauth=${state}${scenario.marker ? "; __Host-isobot_oauth_client=ios" : ""}` },
    }), env, unreachable);
    assert.equal(response.headers.get("Location"), scenario.location);
    assert.match(response.headers.get("Set-Cookie")!, /__Host-isobot_oauth_client=; Max-Age=0/);
    assert.doesNotMatch(response.headers.get("Set-Cookie")!, /__Host-isobot_session/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});
