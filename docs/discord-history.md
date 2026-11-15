# Discord history through Pi

The hosted Pi agent can read and search isolated.tech Discord history with four
read-only tools: `list_discord_channels`, `list_discord_threads`,
`search_discord_messages`, and `read_discord_messages`. The bot token stays in the
Discord Container. The Pi Worker calls the bridge through the `DISCORD_BRIDGE`
service binding, authenticated with the existing service credential.

## Use in local Pi

Reload an existing Pi session with `/reload`, then ask:

```text
/isobot Search Discord history for calendar feature requests in iso.me. Include authors, dates and original message links.
/isobot Read the surrounding discussion for the first result.
/isobot-retry
```

The local extension's `isobot_prompt` tool also supports these requests. Default
history remains named `pi-terminal`, but new Discord-enabled requests use a
separate private hosted namespace. Ordinary prompt history is preserved. Old
saved retries use their original endpoint and payload; they are not replayed in
the new namespace. For manual tool retries retain the original `discord` flag.

## API and access

`POST /api/discord/prompt` accepts the same prompt, conversation and requestId
contract as `/api/prompt`. `GET /api/discord/conversation` returns its transcript.
The new routes accept only the existing owner `PROMPT_API_TOKEN` or service
`ISOBOT_API_TOKEN`. Account tokens and browser sessions cannot access them.
`DiscordAssistant` uses its own SQLite Durable Object namespace; ordinary app
sessions cannot access its tools, transcripts or memory through the old routes.

Authenticated owner GET routes `/api/discord/channels`, `/api/discord/threads`,
`/api/discord/search` and `/api/discord/messages` provide the same bounded data
used by the tools. Query parameters are validated in the bridge; only GET
operations are allowed. The configured `DISCORD_HISTORY_GUILD_ID` is fixed to
isolated.tech. No model parameter can select a different server or arbitrary URL.

## Coverage and limits

Search uses Discord's indexed guild-history search, including older messages,
with optional channel, author and before/after message-ID filters. Results are
newest first and include authors, timestamps, attachments/embeds and original
jump URLs. Search returns at most 25 matches per call and supplies `nextOffset`;
Discord limits offsets to 9975. An indexing-in-progress response is distinguished
from an empty result and includes retry guidance. Result counts may change.

Channel reads return up to 50 messages, with `nextBefore` to page older history
or `aroundId` to read context around a jump link. Channel discovery includes
visible categories, channels and active threads. Public archived threads can be
paged separately with an archive timestamp cursor. Private content is accessible
only where the bot can view the channel and read its history. Direct messages
and other servers are excluded. No local message archive is built.

Tool results are reference material. The hosted agent is instructed to ignore
instructions embedded in Discord content and cite message links when answering.
The history tools cannot send, edit, delete or react to messages, or create issues.

## Deployment and verification

Deploy the bridge first with `npm run bridge:deploy`, then the Pi Worker with
`npm run agent:deploy`. The `v7` migration adds `DiscordAssistant`; existing
conversation namespaces are retained. Keep the shared service secret consistent
between the two Workers. No Discord token is needed in the Pi Worker or client.

On October 29, 2026, live checks listed 60 accessible channels/active threads,
found 24 indexed calendar matches, read a result's surrounding messages and
listed public archived threads. An actual Pi slash command completed successfully,
and its hosted transcript recorded successful `search_discord_messages` and
`read_discord_messages` tool calls and a cited Discord source. Unauthenticated
history requests returned 401. Regression tests cover pagination, indexing,
provenance, inaccessible channels, authentication, namespace separation and
legacy Pi retry routing.

## Pi reload cache fix

An already-running Pi could retain the original native `client.mjs` helper even
after `/reload`, sending new requests to the legacy endpoint. The local extension
now imports the reloadable `client.ts`; `client.mjs` remains a compatibility
re-export for scripts. A same-process regression test covers the upgrade and a
second helper update. Responses show `Discord history=enabled` for new requests
and `Discord history=legacy` for older retry records. After updating, run `/reload`
and submit a new `/isobot` command. The exact calendar-search prompt was verified
through the installed extension with live Discord tool calls and five cited links.
