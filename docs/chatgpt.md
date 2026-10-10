# Connect a ChatGPT plan to Pi

Isobot can use an eligible ChatGPT plan through OpenAI's
[Sign in with ChatGPT flow](https://developers.openai.com/siwc/token-sharing-open-source).
The `ChatGPTAuth` Durable Object owns the connection, model selection, and token
refreshes. Both the HTTP/Vox assistant and Discord ticket agent use that selection.

The deployed agent continues using Workers AI until a ChatGPT model has completed
its verification prompt. Existing conversations switch on their next use without
resetting their transcript. OpenAI documents local/open-source apps and self-hosted
VMs; its documentation does not explicitly establish Cloudflare Workers hosting
eligibility. Hosted offerings are directed to OpenAI's interest form.

## Deployment and administrator credential

Deploy migration `v4` to provision the SQLite-backed `ChatGPTAuth` binding. Set a
dedicated random `CHATGPT_ADMIN_TOKEN` with Wrangler:

```sh
cd cloudflare
npx wrangler secret put CHATGPT_ADMIN_TOKEN
npm run deploy
```

Keep the matching token in the root's gitignored `.env.chatgpt` file with mode
`0600`, or supply `CHATGPT_ADMIN_TOKEN` in the local process environment. Prompt
and Discord bridge tokens cannot read or administer the ChatGPT connection.
Never put token values in command arguments or commit them.

## Sign in and select a model

Run from the repository root:

```sh
npm run chatgpt -- login
npm run chatgpt -- models
npm run chatgpt -- model gpt-6.1-sol
npm run chatgpt -- status
```

Choose a slug returned by `models`, or name a model supported by this Pi version
directly. The example requires inference access for your signed-in account.
Model activation sends a small verification
prompt and succeeds only after a `response.completed` event. HTTP 200 or a model
catalog entry alone does not establish inference access.

Selecting `gpt-6.1-sol` uses medium reasoning. Pi persists that setting with the
model for both HTTP/Vox and Discord conversations, applying it on their next
request without resetting history. Model-list requests refresh the live account
catalog, so a model added after sign-in can be selected without reconnecting.

`login` opens a local browser and waits for its callback at
`http://127.0.0.1:1455/auth/callback`. It verifies OAuth state, PKCE, the signed
identity token, account identity, granted scopes, and token expiry before
importing the connection. `--no-open` prints a local launch link for opening the
browser manually. `--new-account` starts a separate registration instead of
reauthorizing the saved account. `--worker URL` targets another deployment or a
local development Worker.

The local `.chatgpt/` directory retains an opaque local host ID and protected
account registration metadata. The remote credential owner has its own stable
host ID, which the sign-in command uses to identify the Pi runtime. Local files
do not retain access or refresh tokens. The remote
credential owner persists those tokens and serializes their rotation. Credentials
remain separate from Pi's transcript and agent state.

Requests use `https://api.openai.com/v1/responses` with OAuth, streaming, and
`store: false`. The provider adapter groups local tools into a namespace,
preserves tool history across model changes, omits unsupported request fields,
and rejects incomplete responses. Your ChatGPT plan's usage limits apply.

## Switch back or disconnect

```sh
npm run chatgpt -- workers-ai
npm run chatgpt -- disconnect
```

`workers-ai` keeps the ChatGPT connection and restores the configured Workers AI
model for subsequent requests. `disconnect` attempts OpenAI session revocation,
clears the remote tokens, and restores Workers AI. It reports if remote revocation
was not confirmed; disconnect the app in ChatGPT Settings in that case.

If a token refresh is interrupted after redemption, the durable record requires
reconnection. Isobot does not replay a refresh token that may already have rotated.
Run `login` again. Account permissions and usage can be managed in
[ChatGPT Settings](https://chatgpt.com/settings/usage).

## Management API

All routes require `Authorization: Bearer <CHATGPT_ADMIN_TOKEN>` and return
`Cache-Control: no-store`. Credentials are accepted by the import endpoint and
never returned by the management API.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/chatgpt/connection` | GET | Safe connection status, expiry, and selected model |
| `/api/chatgpt/connection` | PUT | Import `{credential}` from the verified local OAuth flow |
| `/api/chatgpt/connection` | DELETE | Revoke and disconnect; returns whether revocation was confirmed |
| `/api/chatgpt/models` | GET | Account models supported by this Pi installation |
| `/api/chatgpt/host` | GET | Stable, opaque identifier for the remote Pi runtime |
| `/api/chatgpt/model` | POST | Verify and select `{model}` |
| `/api/chatgpt/workers-ai` | POST | Restore Workers AI while retaining the connection |
