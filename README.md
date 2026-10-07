# isobot

Discord assistant for isolated.tech. Mention isobot in a reply or a thread to
turn a comment into a GitHub issue. Tagged bug/feature posts in mapped `#help`
forums also become issues, and comments and issue state mirror both ways.

The ticket agent uses Cloudflare's [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi).
`PiHarness` runs Pi Durable on SQLite-backed Durable Objects, with Workers AI
(`@cf/moonshotai/kimi-k2.7-code`), a tool registry, and lifecycle recovery. One
Isobot object owns each Discord message's ticket. The Discord Gateway and
existing forum/GitHub synchronization run on Fly using discord.js.

The deployed Worker is https://isobot-pi.costream.workers.dev. `/health` is public;
agent API routes require bearer authentication. Prompt, Vox intake and note archive
routes accept either
the dedicated `PROMPT_API_TOKEN` or the bridge’s `ISOBOT_API_TOKEN`. Other bot
API routes require the bridge token. The original
first-agent playground remains available at authenticated `POST /api/ask` and
has no GitHub tools.

## Send an HTTPS prompt

```sh
source .env.prompt
curl --fail-with-body https://isobot-pi.costream.workers.dev/api/prompt \
  -H "Authorization: Bearer $PROMPT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello!","conversation":"terminal"}'
```

The JSON response contains `text`, `status`, `conversation`, and `requestId`.
The same conversation retains history. Supply an optional `requestId` to retry
a turn safely. See [the prompt API](docs/prompt-api.md) for the full contract.

Vox.md capture presets can send their existing HTTP JSON directly to
`/api/vox?mode=prompt&conversation=vox` for instructions, or
`/api/vox?mode=memory&conversation=vox` to save reference notes. Both preserve
original Markdown and metadata; Pi can search and read saved memory. See
[Vox setup and Markdown exports](docs/vox-integration.md).

Open [the Pi conversation viewer](https://isobot-pi.costream.workers.dev/console?conversation=vox)
with your bearer token to see prompts, replies, tool activity and saved captures.
Run `npm run agent:logs` for live Worker/Durable Object logs. See
[conversation and log inspection](docs/agent-inspection.md).

## Develop and deploy

```sh
npm ci
npm --prefix cloudflare ci
npm run typecheck
npm run agent:typecheck
npm test
```

Copy `.env.example` to `.env` for the Discord bridge. Set `GITHUB_TOKEN` and
`ISOBOT_API_TOKEN` with Wrangler secrets for the Worker (never commit values):

```sh
cd cloudflare
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ISOBOT_API_TOKEN
npm run deploy
```

Set the deployed Worker origin and matching API token on Fly, then deploy the
bridge with `flyctl deploy --app isobot --ha=false`. Keep one bot machine; the
existing `fly.toml` uses an immediate deployment so two bot processes do not
handle the same events. Existing GitHub webhooks remain at
`https://isobot.fly.dev/gh/webhook`.

## Ticket workflow

The bridge checks the Discord owner/team allowlist and resolves the channel's
repository from `src/config/repos.json`. It submits the message ID, source
comment, request, and recent context to `POST /api/tickets`, then polls
`GET /api/tickets/{messageId}`. Pi calls `create_github_issue` and
`reply_in_discord`; the reply tool saves content for the bridge to deliver.
Vague comments produce a clarification instead of an issue.

The issue tool fixes the destination to a mapped repository and appends the
original quote, source URL, unique event marker, and `@codex implement this`.
Pi submissions deduplicate by message ID. Issue creation is marked unsafe for
automatic replay and checks GitHub's REST listing for its marker on retries.
GitHub does not provide atomic issue-creation idempotency, so an ambiguous
in-flight request still has a small duplicate risk. Generated Discord replies
use nonce enforcement and disable mentions.

Authenticated callers can pass `dryRun: true` in a ticket request to exercise
Pi and its tools with a preview URL without writing a GitHub issue or sending
a Discord message. Poll previews at `GET /api/tickets/{messageId}?dryRun=true`. Preview sessions
are isolated from production tickets and are immutable for their message ID;
use a fresh ID for another preview. Pi Durable and PiHarness are experimental APIs, pinned
in `cloudflare/package.json`.

The Worker records production tickets in a durable delivery inbox before
submitting them to Pi. The bridge checks that inbox on startup and every 30
seconds, resumes unfinished operations, and acknowledges successful Discord
replies. A Fly restart therefore preserves pending delivery. Inaccessible or
deleted source messages remain pending for investigation. A crash after Discord
accepts a reply but before acknowledgment can duplicate delivery after Discord’s
nonce window expires.

See [Discord bridge configuration and limits](docs/discord-bridge.md). Existing
forum and sync handlers keep their current dedupe limits.

See [deployment validation](docs/deployment.md) for the deployed versions and checks.
