# isobot board

[bot.isolated.tech](https://bot.isolated.tech) is a read-only view of what isobot is doing,
so you don't have to piece it together from Discord. It is modelled on
[vercel/board](https://github.com/vercel/board): a sidebar of views, filters in the URL (so every view is a
link), and a side pane with a job's full timeline.

| View | Shows |
| --- | --- |
| Overview | Runner health, what's building, what needs you (review, failed, proposed, waiting to ship), the PRs the sweep says need you, what runs next, today's events |
| Growth | What the scheduled work measures and what it changed, over 30/90/120 days: installs and listing traffic (App Store and Play), Google Play's overall rating and the days with new ratings, search phrases in the top 10, conversion, trials, proceeds, a per-phrase rank table with 7- and 28-day moves, Search Console clicks per week, OpenSEO credits. Listing changes (◆) and published pages (●) are marked on every chart |
| Tasks | The `isobot:*` label queue as columns (proposed → ready → building → review, failed), plus work merged in the last 7 days |
| Activity | The runner's event timeline by day (7 days), split into job and runner-level events, with text search |
| Schedule | Triage, content and ASO trains, analytics, the daily check-in, search and rank reports, release trains, and pending follow-ups |
| Pull requests / Issues | Open items, and items merged or closed in the last 14 days, across every configured repository. Open PRs carry the PR sweep's verdict (merge, land, duplicate, superseded, stale draft) with its reason on hover, and Pull requests has a **Needs you** tab ([PR sweep](runner.md#pull-request-sweep)) |
| Jobs | The runner's 200 latest jobs with state, attempts and PR; click one for its timeline |

The repository list in the sidebar filters every view.

## How it works

```
runner (Mac) ──POST /api/ingest every minute──▶ isobot-board Worker ──▶ BoardState (Durable Object, SQLite)
  runner.sqlite, GitHub token stay here         Bearer INGEST_TOKEN        latest snapshot per runner,
                                                                           GitHub read, 30 days of events
browser ──GitHub sign-in──▶ isobot-board ──RPC──▶ AccountAuth in isobot-pi (same accounts, sessions, allowlist)
```

- **The runner pushes** (`runner/src/dashboard.ts`): its heartbeat state, schedule, jobs, follow-ups,
  new events since the board's last one, and every 5 minutes the open and recently closed issues and PRs
  of each configured repo (two GitHub requests per repo). A push never blocks or fails a cycle; failures are
  logged once and then every 30th time. Builder session ids aren't sent and texts are clipped.
- **Growth series** (`runner/src/metrics.ts`) are built from what runner.sqlite already keeps, with no API calls:
  Apple analytics days (`analytics:<id>:day:*`), Play Console days (`playstats:<pkg>:day:*`), the ASO train's daily
  rank snapshots and listing history (`aso:<id>:day:*`, `aso:<id>:history`), published content pages, the content
  train's weekly Search Console totals (`content:<repo>:search:*`, written by its Monday report) and OpenSEO credits.
  The runner rebuilds them every 15 minutes and sends them only when they changed; the board keeps the latest set
  and serves it at `/api/metrics`. Rank snapshots fill in over the day, so each phrase counts at its newest reading
  from the last 7 days, and the rank trend uses the app's main storefront (`aso.storefront`, default US).
- **The board only reads.** It has no GitHub token and can't change labels, jobs or the runner.
- **Sign-in** reuses Pi's GitHub login (`cloudflare/src/account-routes.ts`) and its `AccountAuth` Durable Object
  through a cross-script binding, so the allowlist (`GITHUB_OAUTH_ALLOWED_IDS`, CodyBontecou only) and session
  rules are the same as [the console's](github-login.md). Only web sign-in, session and sign-out are served:
  no API tokens and no native-app flow. It needs its own GitHub OAuth app because GitHub allows one callback
  host per app.
- The page shell is public and holds no data; `/api/board` and `/api/events` need a session.

## Sources

Every issue and PR shows where its work came from, read from what isobot already writes (no extra API calls):

| Source | How it's recognized |
| --- | --- |
| Discord, email, App Store review, Vox note | Triage's `<!-- isobot:triage:<source>:… -->` marker; the **Source:** link opens the Discord message or review (email links never leave the runner) |
| Vox note | The `from-vox` label from the Vox inbox pipeline |
| isobot chat | `<!-- isobot:chat -->` on issues the staff chat opens |
| Crash report | `<!-- isobot:crash:… -->` on issues the [crash audit](crashes.md) opens |
| Content train, release train | Their issue wording |
| GitHub | Everything else |

PRs take the source of the issue they close (`Closes #n`). Filter by source on the Issues and Pull requests views
(`?source=discord`); Overview counts open issues by source. A new source needs a marker
written where its issues are opened, plus a case in `itemSource()` in `runner/src/dashboard.ts`.

## Setup

1. Register a GitHub OAuth app at [github.com/settings/applications/new](https://github.com/settings/applications/new):

   | Field | Value |
   | --- | --- |
   | Application name | `isobot board` |
   | Homepage URL | `https://bot.isolated.tech` |
   | Authorization callback URL | `https://bot.isolated.tech/auth/github/callback` |

2. Deploy and set secrets, from `board/` (isobot-pi must already be deployed, since the board binds its `AccountAuth`):

   ```sh
   npm ci
   npm run deploy
   npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
   npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
   openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put INGEST_TOKEN   # keep this value for step 3
   ```

   The `custom_domain` route creates the `bot.isolated.tech` DNS record.

3. In `~/Library/Application Support/isobot/runner.env` set `ISOBOT_BOARD_URL=https://bot.isolated.tech` and
   `ISOBOT_BOARD_TOKEN=<the INGEST_TOKEN>`, then restart the runner (check `status` for active builds first).
   The board fills in within a minute.

Rotating the token: put a new `INGEST_TOKEN`, update `runner.env`, restart the runner.

## Development

`npm --prefix board run dev` builds the UI and starts Wrangler. Locally the cross-script `AccountAuth`
binding isn't connected, so sign-in doesn't work; `/health` and `/api/ingest` (with `INGEST_TOKEN` in
`board/.dev.vars`) do. The UI is React built with esbuild into `board/public/assets` (ignored by Git).
Tests: `board/src/store.test.ts` and `runner/src/dashboard.test.ts`, both in `npm test`.
