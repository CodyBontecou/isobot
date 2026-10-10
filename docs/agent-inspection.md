# View Pi conversations and logs

Open [the Pi console](https://isobot-pi.costream.workers.dev/console?conversation=vox)
and sign in with GitHub. The account controls create and revoke API tokens for
Vox. See [GitHub login setup](github-login.md). The advanced bearer connection
also accepts the existing Vox token; it stays only in the tab's memory.

The console also supports chatting with Pi, managing shared workspace files,
viewing resource usage and published pricing, and GitHub account sign-in when
OAuth is configured. See [the console guide](console.md) for those workflows.

The conversation name must match the `conversation` parameter in your Vox
preset URL. `vox` is the default. Refresh retrieves:

- Stored user prompts, Pi replies, and tool calls/results.
- Pending operations and whether Pi is currently working.
- Archived Vox captures and their current Pi response.
- Authenticated Markdown, original-payload JSON, and response downloads.

Use **Load earlier** for older conversation messages. The viewer reads archived
entries from before context compaction or resets as well as recent messages.
Memory-only captures appear under **Captures**; they do not create model
messages. While Pi is busy, the console refreshes the transcript every 2.5 seconds.

The public `/console` page contains only the interface. Conversation and capture
data require an authenticated session or bearer token. External text is rendered
as escaped text or safe Markdown, and
the page only connects to the Worker's own origin. The transcript presents
visible messages and tools; it excludes model thinking, provider signatures,
and private harness metadata.

## Conversation API

```sh
source .env.prompt
curl --fail-with-body \
  'https://isobot-pi.costream.workers.dev/api/conversation?conversation=vox&limit=100' \
  -H "Authorization: Bearer $PROMPT_API_TOKEN"
```

The JSON response includes `conversation`, `model`, `busy`, `pending`, and
chronologically ordered `entries` for the latest page. If `nextCursor` is
present, pass it as `before` for the next older page. `limit` accepts 1–100.
Responses are bounded; long message text and tool arguments have a visible
ellipsis. A page may have no visible entries but a cursor when it crosses many
internal bookkeeping records. Reading starts the harness if needed and may
resume previously pending work; it does not submit a new prompt or reset history.

## Runtime logs

From the repository directory:

```sh
npm run agent:logs
```

This runs `wrangler tail isobot-pi --format pretty`. Leave it running while
sending another Vox capture to see incoming requests, console events and errors.
Press Control-C to stop. For JSON or error filtering, run from `cloudflare`:

```sh
npx wrangler tail isobot-pi --format json
npx wrangler tail isobot-pi --status error
```

Cloudflare's dashboard also provides **Workers & Pages → isobot-pi → Logs →
Live**, including logs emitted by Durable Objects.
[Cloudflare's live-log documentation](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)
describes both interfaces. Worker observability was already enabled, so stored
invocation/custom logs are available under the Worker's Logs page subject to
your account's retention.
[Workers Logs documentation](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

Our custom events record capture IDs, modes, retry flags, operation IDs and
status: `vox_capture_stored`, `pi_operation_submitted`, `pi_operation_completed`,
and `pi_report`. Completion is logged when the result is collected by a client.
These custom events do not include bearer tokens, capture contents or model
reply text; those are available through the authenticated conversation/capture
APIs. Live tailing starts from the current moment. Stored conversations remain
available independently of runtime-log retention.
