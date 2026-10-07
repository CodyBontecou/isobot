# Deployment record — October 7, 2026

Built from Cloudflare's [Pi guide](https://developers.cloudflare.com/agents/harnesses/pi/)
and its [linked harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi).

| Service | Deployed state |
| --- | --- |
| Pi Worker | `https://isobot-pi.costream.workers.dev` |
| Worker version | `f666aba2-119e-4ff8-9430-a91fad631a20` |
| Model | Workers AI `@cf/moonshotai/kimi-k2.7-code` |
| Durable Objects | `Assistant`, `Isobot`, `DeliveryInbox` with SQLite migrations v1–v3 |
| Discord bridge / sync | Existing Fly app `isobot`, `https://isobot.fly.dev` |
| Fly image | `isobot:deployment-01M4B5GSST5WBQFF8MXG6QDDQ6` |
| Discord identity | `isobot#9767` |

Validation completed:

- 95 tests passed, including real Workers SQLite restart persistence, delivered
  tombstones, fair backlog recovery, bridge retries, stale delivery suppression,
  and GitHub marker reconciliation.
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
