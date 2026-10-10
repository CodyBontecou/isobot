# Isobot support integration

The v1 client is integrated into myself.md's phone Settings → Contact support and dashboard Support view. The service runs inside Isobot's Cloudflare Worker. The previous client/server API remains available for compatibility.

## Behavior

Each authenticated account has an inbox of independent conversations. Creating a conversation saves its title as the first user prompt and queues Pi and Discord delivery atomically. Repeating the same creation ID returns the original conversation without duplicating its prompt or jobs. Existing conversations are not backfilled. Each Pi operation has a separate durable harness and receives that conversation's canonical text plus approved attachment metadata. Pi can read source, answer questions, request data, create GitHub tickets, and dispatch a Codex first pass. Staff use private Discord threads. Their first reply pauses automatic Pi responses; the owner can resume them.

A data request describes a category, reason, time range, and optional operations/outcome filter. Reviewing collects locally. The owner can edit or cancel the preview. Sharing requires an explicit acceptance, matching SHA-256 digest, and current conversation generation. Phone logs default to the last 24 hours; other data can be provided manually in the editable preview. The dashboard supports manual snapshots and directs phone log collection to the phone. This does not automatically read arbitrary native data or change existing OS permissions or diagnostics capture settings.

Attachments are encrypted with AES-GCM before durable storage. Archive fences in-flight operations, aborts and erases the Pi harness, deletes attachment ciphertext, and preserves text and removed-attachment metadata. Reopening requires new snapshots. Deletion removes the canonical conversation and requests deletion of the Discord thread. Account deletion blocks recreation and removes devices and all conversations. External Discord cleanup is asynchronous and retried by the relay. Provider retention and Cloudflare storage backups are outside live-store deletion; approved data already processed by a model cannot be recalled.

Mobile notifications contain generic reply/request text and a conversation ID. Permission is requested only through the owner's enable button. Already-authorized devices re-register on foreground. Logout attempts token removal; delivery failures/receipts retire invalid tokens. Tapping verifies current account ownership before opening the conversation. Push is a delivery hint; inbox reads remain authoritative.

Issues, source reads and Codex dispatch target the deployment-controlled `SUPPORT_GITHUB_REPOSITORY` (`owner/repo`), configured here as `CodyBontecou/myself.md`. `SUPPORT_GITHUB_REF` selects the workflow ref (here `main`). Customers and models cannot override either setting. Missing or invalid repository configuration fails closed. Codex jobs store their repository/ref when queued, so configuration changes do not redirect existing jobs; completion URLs must belong to the stored repository. Legacy queued jobs retain their recorded repository and default to the configured ref. It produces a draft PR for review. Bugs in other repositories require staff follow-up. Tickets and tasks must contain sanitized findings, not raw attachments. Retry reconciliation uses deterministic IDs and GitHub/Discord markers; an ambiguous external write is not a distributed transaction.

## Deployment

These are source changes; nothing has been deployed, pushed, or sent to live Discord/GitHub during implementation.

| Location                         | Required configuration                                                                                                                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| myself.md service/Worker         | `SUPPORT_ISOBOT_ORIGIN` (exact HTTPS origin), `SUPPORT_ISOBOT_TOKEN` matching Isobot's service token                                                                                                                                                                                                      |
| Isobot Worker                    | `SUPPORT_SERVICE_TOKEN`, `SUPPORT_BRIDGE_TOKEN`, `SUPPORT_TASK_TOKEN` (distinct), `SUPPORT_ENCRYPTION_KEY` (64 hex characters), existing AI/ChatGPT bindings, `SUPPORT_GITHUB_REPOSITORY`, `SUPPORT_GITHUB_REF`, `GITHUB_TOKEN` with source, issues and workflow-dispatch access to the target repository |
| Isobot Discord process           | `ISOBOT_AGENT_URL`, `SUPPORT_BRIDGE_TOKEN`, `SUPPORT_DISCORD_CHANNEL_ID`, comma-separated `SUPPORT_DISCORD_STAFF_IDS`, existing bot login                                                                                                                                                                 |
| Target repository GitHub Actions | Enable draft PR creation; repository secrets `CODEX_API_KEY`, `SUPPORT_ISOBOT_ORIGIN`, `SUPPORT_TASK_TOKEN`; push `.github/workflows/support-codex.yml` and `scripts/support-task.js` to the configured ref                                                                                               |
| Mobile app                       | SDK 57 notification plugin/modules, existing Expo EAS project ID, provisioned APNs/FCM credentials, a rebuilt binary                                                                                                                                                                                      |

Deploy the Isobot Worker with its three new SQLite Durable Object bindings/migration. Deploy the myself.md proxy and built dashboard. Restart the Discord process after configuring a private guild text channel that denies everyone visibility and grants only the bot and named staff. The relay refuses a channel with broader visibility. Install the rebuilt mobile app; an OTA update alone cannot add native notification modules.

## Verification

- `npm run check` in support-chat checks the exported native/web clients.
- `npm run format` and `npm run check` in myself.md cover host and copied package source.
- `node scripts/verify-support-v1.js` in myself.md exercises the real MCP transport and browser approval flow with deterministic fixtures.
- `npm test`, `npm run typecheck`, and `npm run agent:typecheck` in Isobot cover the service and existing integrations. `cloudflare/src/support-integration.test.ts` runs real SQLite Durable Objects in Miniflare with a fake Pi runner.
- `npm run bundle`, `npm run build:ios:debug`, and `ANDROID_HOME=<installed-sdk> npm run build:android` in myself.md verify module resolution and native compilation.

Live Pi inference, production Discord/GitHub delivery, APNs/FCM delivery, and physical-device notification interaction still need configured deployment testing. The fixture does not claim those effects.

## In-app support roles

The myself.md server sends a verified `X-Support-Role` with its private service credential. The hosted proxy recognizes the developer by GitHub account ID `20440899`; local servers can set `SUPPORT_OWNER_SUBJECT` to the exact authenticated account subject. Ticket creation does not require purchase verification. Guests are always restricted, even if a host request incorrectly asserts an elevated role.

- Developer: all support tools, with existing snapshot approval still required.
- Authenticated lifetime customer: public app guidance and GitHub ticket creation.
- Guest or authenticated customer without lifetime access: public app guidance and GitHub ticket creation.

Public guidance is bundled text and exposes no repository source or personal notes. The model receives only its operation's allowed tools, and tool execution checks current account permissions. Role assertions expire after five minutes; opening or sending support messages refreshes them. Pending Codex dispatch is cancelled after a downgrade or expiry. Existing console and Discord authorization is unchanged. Deploy the myself.md proxy and isobot together; a legacy proxy without a role header safely defaults to app guidance and ticket creation.

Changing the target requires installing the workflow and callback script plus their secrets in that repository before deploying the new Worker settings. These settings apply to this support-service deployment; use separate deployments/service credentials for applications that need different repository scopes. Existing issues and PRs are not moved.
