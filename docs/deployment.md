# Deployment record — October 7, 2026

Built from Cloudflare's [Pi guide](https://developers.cloudflare.com/agents/harnesses/pi/)
and its [linked harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi).

| Service | Deployed state |
| --- | --- |
| Pi Worker | `https://isobot-pi.costream.workers.dev` |
| Worker version | `e9012895-a397-4209-9828-448767e692a1` |
| Active model | ChatGPT plan `gpt-6.1-sol`, medium reasoning |
| Workers AI fallback | `@cf/moonshotai/kimi-k2.7-code`, restored explicitly with `chatgpt -- workers-ai` |
| ChatGPT connection | OAuth sign-in and completed inference verified; automatic refresh enabled |
| Console GitHub login | OAuth configured; CodyBontecou signed in and session reload verified |
| Durable Objects | `Assistant`, `Isobot`, `DeliveryInbox`, `ChatGPTAuth`, `AccountAuth` with SQLite migrations v1–v5 |
| Discord bridge / sync | Existing Fly app `isobot`, `https://isobot.fly.dev` |
| Fly image | `isobot:deployment-01M4B5GSST5WBQFF8MXG6QDDQ6` |
| Discord identity | `isobot#9767` |

Validation completed:

- Native iOS GitHub sign-in deployed and verified on October 7, 2026 at
  21:08 Europe/Lisbon. The console build, Worker/console typechecks, dry run and
  61 focused account/native authorization tests passed. Live checks returned
  HTTP 200 for health, the OAuth-configured session endpoint and console assets;
  native exchange returned 400 for malformed input, 403 for a missing origin,
  405 for GET and 401 for an unknown code. Native and web login both redirect
  to GitHub with S256 and the existing HTTPS callback. Native login sets secure
  browser bindings and a denied flow returns `isobot://auth?error=denied`;
  denied web login still returns to the console. No GitHub consent or session
  creation was performed during these production checks. Previous rollback
  version: `753751a5-c1b1-4b84-8b5a-7bd883dad0d2`.
- The OAuth sign-in view uses a responsive GitHub card, workspace context and
  an expandable bearer-token fallback. Its scoped styles follow the existing
  system light/dark palette. Console typechecking and build passed; desktop and
  phone browser checks verified the layout and fallback without horizontal
  overflow or browser errors. The redesigned view was verified on the deployed
  console. The registered GitHub OAuth app and Worker credentials now complete
  sign-in as CodyBontecou, retain the existing Vox conversation, and load account
  token controls. The seven-day browser session survives a reload.
- The console follows the system light/dark preference through CSS media queries,
  with matching native control and browser chrome colors. Console build and
  typechecks passed. Browser previews covered both palettes, dark chat and file
  editing, captures, resources, account dialogs, and phone sign-in/workspace
  views. The deployed stylesheet and appearance metadata were verified live.
- 196 tests passed in the full suite, plus the final targeted public-assets and
  scoped-account checks. Coverage includes real Workers SQLite restart persistence, delivered
  tombstones, fair backlog recovery, bridge retries, stale delivery suppression,
  and GitHub marker reconciliation.
- GitHub account login and token management are deployed. Tests cover S256 PKCE,
  single-use browser-bound state, the owner allowlist, Secure/HttpOnly sessions,
  CSRF and origin validation, credential precedence, hash-only storage,
  expiry/revocation, and read/write permissions for prompts, chat, files and
  resources. The [GitHub OAuth app](github-login.md) is registered and its client
  credentials are stored as Worker secrets. A native Workers regression exposed
  unsupported `redirect: "error"` fetches; OAuth and GitHub tools now use manual
  redirects and reject redirect responses without forwarding credentials. All
  54 focused account/GitHub tests and Worker/console typechecks passed.
- The React console includes account tokens, asynchronous chat, capture exports,
  workspace files, revision conflict handling and resource usage/unit pricing.
  Worker, bridge and console typechecks passed. Browser checks covered session
  failures, expired credentials, login errors, token controls, chat, phone layouts,
  file editing, captures and resource details. The production dependency audit
  found zero vulnerabilities.
- Production chat/workspace checks used an isolated conversation. Chat admission
  returned HTTP 202 in 254 ms; GPT-6.1 Sol invoked `read_workspace_file` and
  `write_workspace_file`, and the saved output matched the requested content.
  Both tool calls appeared in the transcript. Resource inspection returned
  nonzero measured tokens and `actualBill: null`. Disposable test files were
  removed and the test workspace was verified empty; Vox history was untouched.
- ChatGPT OAuth tests cover signed identity verification, dedicated administrator
  authentication, serialized token rotation, completed inference checks, and Pi
  memory tool history across a real Workers runtime restart. Credentials and
  upstream response text stay out of diagnostics. Live sign-in, the account model
  catalog, and completed `gpt-5.6-sol` inference succeeded. The live memory-tool
  check searched and read an isolated saved note, answered `47 × 19 = 893`, and
  recalled both values in a follow-up. The transcript recorded both tool calls,
  and the existing Vox conversation retained its entries after model selection.
  After the user selected GPT-6.1 Sol, its explicit verification completed with
  medium reasoning even though the fresh account picker omitted that slug.
  Only installed Pi models can use explicit verification, and only a completed
  response activates one. The shared session update persists model and medium
  reasoning together for HTTP/Vox and Discord while retaining their history.
  Real Workers integration checks assert medium on every GPT-6.1 request,
  including tools and calls after restart. Live GPT-6.1 inference searched and
  read the prior verification note, recalled its codeword and the earlier
  calculation, and retained the existing Vox transcript after the model switch.
  Headerless SSE is accepted only when a
  completed Responses event is received; plain JSON or partial streams cannot
  activate a model.
- The HTTPS prompt API adds scoped bearer authentication, persistent conversation
  routing, generated or caller-provided request IDs, and durable retry conflict checks.
- Live HTTPS checks returned a model answer, recalled a codeword in a follow-up,
  returned an identical retry result, rejected a conflicting prompt with 409,
  and rejected use of the prompt token on bot service routes with 401.
- Vox HTTP intake supports prompt and memory modes chosen per preset's URL.
  Live checks stored a memory note, retrieved exact Markdown and original JSON
  fields, then submitted a recording-shaped prompt with `cleanedText`. The
  receipt returned in 180 ms and Pi recalled the stored codeword using memory
  tools. Prompt replay reused the result; pagination and conflict checks passed.
- Vox's synthetic Send Test passed without adding a capture. Prompt receipts
  return only after Pi's durable admission; response downloads are independent
  of Vox's 30-second request timeout.
- The deployed [conversation viewer](https://isobot-pi.costream.workers.dev/console?conversation=vox)
  and protected transcript API expose saved prompts, replies, tools, pending
  operations, and capture downloads. Live checks found the user's latest Vox
  request and completed reply, verified memory tool history, and rejected
  unauthenticated transcript access. Viewer shell and transcript pagination,
  safe projection, bounds, and authorization tests passed.
- Live Wrangler tailing received `vox_capture_stored` for an idempotent replay
  of the existing Vox capture. `npm run agent:logs` starts the same log stream.
  See [conversation and log inspection](agent-inspection.md).
- Discord production build and both TypeScript checks passed.
- Both dependency sets audited with zero vulnerabilities.
- First Pi agent answered `47 × 19` with `893`; its transcript survived later deployments.
- Live ticket preview exercised both isobot tools; repeating the event returned
  `accepted: false`. Preview sessions are isolated from production.
- Both production health endpoints returned HTTP 200.
- Fly logged in to Discord with the existing owner allowlist and authenticated
  successfully to the Pi Worker. The production delivery inbox was empty.
- GitHub issue reads succeeded for all six configured repositories. Live tool
  checks used preview mode, so they did not create test issues or send messages.

The existing GitHub webhook URLs and forum/comment sync remain on Fly. The
approved GitHub credential transfer and generated shared API token were stored
as service secrets; temporary local copies were deleted. This repository
contains the deployed source, configuration, and validation records.

The dedicated `PROMPT_API_TOKEN` is configured as a Worker secret. Its local
client copy is saved in the gitignored `.env.prompt` file with mode 0600;
the temporary Wrangler transfer file was deleted. See [the HTTPS prompt API](prompt-api.md)
and [Vox preset integration](vox-integration.md).

The dedicated `CHATGPT_ADMIN_TOKEN` is configured as a Worker secret. Its local
gitignored `.env.chatgpt` copy has mode 0600; the provisioning transfer file was
deleted. OAuth access and refresh tokens are retained only by `ChatGPTAuth`,
separate from conversations. See [ChatGPT setup and rollback](chatgpt.md).

The GitHub login client ID and secret are stored in Worker secrets. The temporary
local credential transfer file and setup receiver were removed after successful
sign-in. GitHub login tokens are used only for identity lookup and discarded;
account API tokens are managed through the signed-in console.
