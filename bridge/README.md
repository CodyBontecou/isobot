# Discord bridge on Cloudflare Containers

The `isobot-discord-bridge` Worker routes `/health` and `/gh/webhook` to one
`DiscordBridge` Container named `production`. It runs the repository's existing
Node.js/discord.js application. The Pi agent remains at
`https://isobot-pi.costream.workers.dev`.

The one-minute Cron Trigger checks the same instance and starts it if needed.
Each request renews the ten-minute idle timeout. A durable alarm checks every
30 seconds and recovers a stopped process. The fixed instance name routes all
traffic to one Container, preventing parallel Discord Gateway consumers.
The Container uses the `durable_object` scheduling policy and the `lite` instance
size; image changes replace the old process before starting the new one. `/health` returns 200 only while Discord is
ready; startup/reconnection returns 503.

## Deploy

From the repository root:

```sh
npm ci
npm ci --prefix bridge
npm run typecheck
npm run bridge:typecheck
npm test
npm run bridge:deploy
```

Docker with buildx must be running for deployment. When using Colima, set
`DOCKER_HOST` to its actual socket if the selected Docker context is stale.
Wrangler supports `DOCKER_CONFIG` for a separate Docker configuration.

The Worker secret names are declared in `wrangler.jsonc`. Upload them with
`wrangler secret bulk` from a private JSON file; never pass values on the command
line or commit the file. They are injected at runtime, not baked into the image.
`SUPPORT_BRIDGE_TOKEN`, `SUPPORT_DISCORD_CHANNEL_ID`, and
`SUPPORT_DISCORD_STAFF_IDS` preserve the private support relay configuration.
`ISOBOT_ALLOWED_USERS` defaults to the existing application owner/team behavior.

```sh
curl --fail https://isobot-discord-bridge.costream.workers.dev/health
cd bridge
npx wrangler tail --format pretty
npx wrangler containers list
```

## GitHub webhooks and cutover

The canonical webhook URL is
`https://isobot-discord-bridge.costream.workers.dev/gh/webhook`.
`npm run webhooks:register` updates an existing Fly hook in place, rather than
creating a duplicate, and exits unsuccessfully if any repository update fails.
It requires `GITHUB_TOKEN` with webhook administration permissions and the
existing `GITHUB_WEBHOOK_SECRET` in its environment.

Keep the old Fly machine stopped. Only one hosting environment may run the bot.
The stopped machine is retained for rollback. To return to Fly, first call the authenticated
`POST /admin/pause` endpoint; this saves a persistent pause flag, cancels the
alarm, and stops the Container. The cron respects the pause flag. Verify it stays stopped before
starting Fly and restoring GitHub webhook URLs. Pi and its durable data do not
need to move during either cutover.

## Validation

Check the live health response for `discordReady: true`, then verify a GitHub
webhook ping delivery receives HTTP 202. An unsigned request must receive 401.
The local webhook test covers readiness status and signature acceptance/rejection.
Use a real authorized mention for user-facing acceptance of the complete ticket
flow; health and webhook pings alone do not prove model or issue creation.

Lifecycle controls `POST /admin/pause`, `/admin/resume`, and `/admin/restart`
require `Authorization: Bearer <ISOBOT_API_TOKEN>`. Unauthenticated requests are
rejected before reaching the Container. Keep this token in your secret store.
The lifecycle regression test covers singleton startup, alarm recovery, image
replacement, authorization, pause persistence, resume, and restart.

## Discord history

Owner-authenticated GET `/api/discord/channels`, `/api/discord/threads`,
`/api/discord/search` and `/api/discord/messages` expose read-only Discord access.
`DISCORD_HISTORY_GUILD_ID` fixes the server; the bridge checks channel visibility
and history permissions. The Pi Worker uses a service binding and the shared
service token. See [Discord history through Pi](../docs/discord-history.md).
