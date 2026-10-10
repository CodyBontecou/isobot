# GitHub login and API tokens

The console supports GitHub sign-in and a seven-day browser session. Login is
restricted to CodyBontecou's stable GitHub account ID, `20440899`. It opens the
existing conversations and captures; it does not create a new agent history.

Production sign-in is configured and verified. The registered
[`isobot Pi` OAuth app](https://github.com/settings/applications/3912510) belongs
to CodyBontecou; its client credentials are stored as Worker secrets. Open the
console and choose **Continue with GitHub**, then open your account to manage API
tokens. The setup steps below document how to reproduce or replace the app.

## Configure the OAuth app

Register an app in [GitHub's OAuth app settings](https://github.com/settings/applications/new):

| Field | Value |
| --- | --- |
| Application name | `isobot Pi` |
| Homepage URL | `https://isobot-pi.costream.workers.dev/console` |
| Authorization callback URL | `https://isobot-pi.costream.workers.dev/auth/github/callback` |

Device flow is not required. Copy the Client ID and generate a client secret
on the app's settings page. GitHub documents the registration process in
[Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).
Configure both values as Worker secrets, from `cloudflare`:

```sh
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
```

Paste values into the interactive prompts. The nonsecret `AUTH_ORIGIN` and
`GITHUB_OAUTH_ALLOWED_IDS` are configured in `wrangler.jsonc`. Login fails closed
until both client settings are present. The existing bearer connection remains
available for the transition.

The login flow uses authorization codes with S256 PKCE and a single-use,
ten-minute state bound to the browser. It requests no OAuth scopes: only the
public GitHub identity is needed. GitHub access tokens are discarded after
identity lookup. This login is separate from the agent's GitHub issue token and
its ChatGPT model connection.

## Create a Vox token

Sign in to [the console](https://isobot-pi.costream.workers.dev/console?conversation=vox),
then open the account's API token controls. Give the token a name such as
`Vox iPhone`, choose read/write access, and choose an expiry. The default is
90 days; 30 days, one year and no expiry are also supported.

The full token is displayed only at creation. Copy it to Vox's HTTP bearer-token
field. The HTTP destination and prompt/memory query parameters stay the same;
see [Vox integration](vox-integration.md). Read-only tokens can inspect saved
captures, conversations, files and resources, but cannot submit prompts or edit
files. Tokens cannot create other tokens or access Discord service or ChatGPT
administration routes.

Each token has its own last-used timestamp and can be revoked independently.
Revocation and expiry are checked on every request. Up to 50 active tokens can
exist for the account. Only token hashes and display metadata are stored in the
separate SQLite `AccountAuth` object. Browser sessions use Secure, HttpOnly,
SameSite=Lax cookies, and mutations require the session's CSRF value and the
configured origin. Logout invalidates the stored session immediately.

## Account API

| Endpoint | Behavior |
| --- | --- |
| `GET /auth/github/login?conversation=vox` | Start GitHub sign-in |
| `GET /auth/github/callback` | Validate the GitHub callback and set the session |
| `GET /api/auth/session` | Session identity and CSRF token, or signed-out status |
| `GET /api/auth/tokens` | Token metadata; never the full token |
| `POST /api/auth/tokens` | Create a token; returns its full value once |
| `DELETE /api/auth/tokens/:id` | Revoke an account-owned token |
| `POST /auth/logout` | Revoke the current browser session |

Token management requires a browser session. Mutating requests also require
`Origin: https://isobot-pi.costream.workers.dev` and `X-CSRF-Token` from the session
response. A creation body is `{ "name": "Vox iPhone", "scopes": ["read", "write"],
"expiresInDays": 90 }`. The expiry accepts `30`, `90`, `365`, or `null`. Private
responses use `Cache-Control: no-store`; credentials stay out of custom logs.
