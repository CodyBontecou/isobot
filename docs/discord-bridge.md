# Discord bridge and Pi agent

Isobot keeps its Discord Gateway connection on Fly so mentions, forum posts, and
thread comments continue to arrive through `discord.js`. Ticket drafting now runs
on a Cloudflare Pi Durable agent. Each triggering Discord message identifies one
durable ticket operation.

The Fly process requires these environment variables:

- `DISCORD_BOT_TOKEN`: the existing Discord bot token.
- `GITHUB_TOKEN`: still used by the forum and comment sync handlers on Fly.
- `ISOBOT_AGENT_URL`: the deployed Cloudflare Worker origin, such as
  `https://isobot-agent.example.workers.dev`. Remote URLs require HTTPS;
  HTTP is permitted for localhost development. Credentials, queries, and
  fragments are rejected.
- `ISOBOT_API_TOKEN`: the bearer token also configured as a Worker secret.
- `GITHUB_WEBHOOK_SECRET`: keep the existing secret to enable the Fly webhook
  server.
- `ISOBOT_ALLOWED_USERS`: optional comma-separated Discord user IDs. The
  application owner/team remains the default allowlist.

The Fly bridge no longer needs an OpenAI API key. Its HTTP health check and
`/gh/webhook` endpoint stay on Fly. Leave the existing GitHub webhook destinations
in place while this bridge owns the forum and issue synchronization handlers.

## Wire contract

The source of truth is `src/agent/types.ts`, which contains only JSON-compatible
interfaces and does not import Discord or any model SDK.

The bridge submits `POST /api/tickets` with:

```json
{
  "eventId": "the-triggering-discord-message-id",
  "repo": { "owner": "codybontecou", "repo": "Sync.md" },
  "context": {
    "trigger": { "authorTag": "...", "authorId": "...", "content": "...", "jumpUrl": "...", "createdAt": "..." },
    "parent": { "authorTag": "...", "authorId": "...", "content": "...", "jumpUrl": "...", "createdAt": "..." },
    "recent": [],
    "channelName": "help",
    "guildName": "isolated.tech"
  }
}
```

Both endpoints require `Authorization: Bearer <ISOBOT_API_TOKEN>`. Submission
returns `{ "operationId": "the-same-eventId" }`. The Worker must make repeated
submission with the same ID idempotent.

The bridge then polls `GET /api/tickets/{eventId}`. It requires `operationId` and
`status` in the response. Status is `queued`, `running`, `done`, or `unanswered`.
Optional terminal fields are `issueUrl`, `replyContent`, `text`, and `reason`.
A `delivered: true` flag means the original result was already acknowledged;
the bridge skips another reply even if it holds a stale recovery snapshot.

For a finished operation, the bridge sends `replyContent`, falling back to `text`
and then a confirmation containing `issueUrl`. The Worker’s logical
`reply_in_discord` tool stores response content; the bridge sends the actual
Discord message with `nonce: eventId` and `enforceNonce: true`. Mentions are
disabled in generated replies.

## Recovery and limits

The Worker saves each production ticket in a durable delivery inbox before
submitting it to Pi. The bridge checks `GET /api/pending` on startup and every
30 seconds with up to four concurrent recoveries, fetches the original Discord
message, resumes the operation, and acknowledges successful delivery with
`POST /api/tickets/{eventId}/delivered`. Acknowledged events keep a tombstone so
a duplicate submission does not reopen their delivery. Inaccessible source
messages remain pending. Inbox polling rotates through pending batches so
inaccessible messages cannot monopolize recovery of newer tickets.

The bridge retries transport failures and HTTP 429/5xx responses for up to three
attempts, respecting `Retry-After` up to 30 seconds. POST retries retain the same event ID. Each HTTP request has a 30-second
timeout. Polling starts at one second and backs off to five seconds, for up to
ten minutes. Reaching that limit does not cancel the durable operation; its status
can still be retrieved from the authenticated Worker endpoint.

Pi submission idempotency prevents a duplicate model run. GitHub issue creation
also needs its own saved result or issue marker reconciliation because a remote
write can succeed immediately before a crash. Discord nonce enforcement
suppresses duplicate replies only within Discord’s recent-message window.

The existing forum and synchronization handlers are unchanged. Their in-memory
caches and dedupe behavior remain separate from Pi’s durable ticket operations.
The mention handler suppresses concurrent duplicate events within one process.
Only one Fly bot process should handle live events during deployment.
