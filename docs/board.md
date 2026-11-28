# isobot board

[bot.isolated.tech](https://bot.isolated.tech) shows what isobot is doing, so you don't have to piece it
together from Discord, and lets you approve, stop, retry or dismiss tasks without going to Discord or GitHub. It is modelled on
[vercel/board](https://github.com/vercel/board): a sidebar of views, filters in the URL (so every view is a
link), and a side pane with a job's full timeline.

| View | Shows |
| --- | --- |
| Overview | Runner health, what's building, what needs you (review, failed, proposed, waiting to ship), the PRs the sweep says need you, what runs next, today's events |
| Summary | One day, week (Mon–Sun) or month at a time, in your time zone, against the period before (or, for one still under way, the same stretch of it): PRs merged, issues opened and closed, failed builds, runner errors, activity by hour or day, what shipped, new issues by source, what the trains, content and ASO did, problems, work per repository, and store numbers, listing changes and published pages. Step with ‹ › or the arrow keys, jump with the calendar (shaded by activity) or **Today** (`t`); `d`/`w`/`m` switch period, and clicking a day in the chart opens it. `?view=summary&period=month&date=2026-11-01` links to a period |
| Growth | What the scheduled work measures and what it changed, over 30/90/120 days: installs and listing traffic (App Store and Play), Google Play's overall rating and the days with new ratings, search phrases in the top 10, conversion, trials, proceeds, a Revenue section from Apple's Sales and Trends reports (proceeds by month by kind, this month against last, the recurring run-rate, trial conversion, yearly totals, each app's last four months and trials and cancellations; per app its proceeds by month, active subscriptions by plan, and trials, conversion, renewals and cancellations by week), a per-phrase rank table with 7- and 28-day moves, Search Console clicks per week, OpenSEO credits. Listing changes (◆) and published pages (●) are marked on every chart |
| Tasks | The `isobot:*` label queue as columns (proposed → ready → building → review, failed), plus work merged in the last 7 days. Each card has buttons for what can be done to it ([Task actions](#task-actions)) |
| Activity | The runner's event timeline by day (7 days), split into job and runner-level events, with text search |
| Schedule | Triage, content and ASO trains, analytics, the daily check-in, search and rank reports, release trains, and pending follow-ups |
| Pull requests / Issues | Open items, and items merged or closed in the last 14 days, across every configured repository. Open PRs carry the PR sweep's verdict (merge, land, duplicate, superseded, stale draft) with its reason on hover, and Pull requests has a **Needs you** tab ([PR sweep](runner.md#pull-request-sweep)) |
| Jobs | The runner's 200 latest jobs with state, attempts and PR; click one for its timeline |
| Artifacts | Claude's published artifacts (designs, pages, docs on claude.ai) grouped by project, with search; the repository filter keeps the ones filed under that repo ([Artifacts](#artifacts)) |

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
  train's weekly Search Console totals (`content:<repo>:search:*`, written by its Monday report), OpenSEO credits,
  and Apple's Sales and Trends reports (`sales:<id>:day:*`, `sales:<id>:year:*`, `subs:<id>:day:*`, `subev:<id>:day:*`; [analytics](analytics.md)).
  The runner rebuilds them every 15 minutes and sends them only when they changed; the board keeps the latest set
  and serves it at `/api/metrics`. Rank snapshots fill in over the day, so each phrase counts at its newest reading
  from the last 7 days, and the rank trend uses the app's main storefront (`aso.storefront`, default US).
- **History for the Summary view**: the board keeps runner events for 400 days, and every issue, PR and job it has
  seen (newest copy), so periods older than a snapshot's 14 days of closed items still count. `/api/summary` returns
  event counts per UTC hour, kind and repo (the browser cuts them into local days), the named events (merges,
  failures, trains, ASO, content, crash issues, `*_error`), and the items and jobs for the period; `/api/calendar`
  returns counts for the date picker. History starts when the board does, and the view says when a period predates it.
- **The board has no GitHub token.** It can't change labels, jobs or the runner itself; it only queues
  [task actions](#task-actions) for the runner to apply.
- **Sign-in** reuses Pi's GitHub login (`cloudflare/src/account-routes.ts`) and its `AccountAuth` Durable Object
  through a cross-script binding, so the allowlist (`GITHUB_OAUTH_ALLOWED_IDS`, CodyBontecou only) and session
  rules are the same as [the console's](github-login.md). Only web sign-in, session and sign-out are served:
  no API tokens and no native-app flow. It needs its own GitHub OAuth app because GitHub allows one callback
  host per app.
- The page shell is public and holds no data; `/api/board` and `/api/events` need a session.

## Task actions

Cards on the Tasks view have buttons. Each one is the same label change as the matching Discord reaction
(`planFor` in `src/discord/approval.ts`, `planBoardAction` in `runner/src/boardActions.ts`), so the pipeline
treats it the same way:

| Button | Shown on | Labels |
| --- | --- | --- |
| Approve (✅) | Proposed and other unapproved tasks | `+isobot:ready`, `-isobot:proposed` |
| Stop (🛑) | Ready, building | `+isobot:stop`, `-isobot:ready` |
| Retry (🔁) | Failed or stopped | `-isobot:stop`, `+isobot:ready` unless a build or PR is already on it |
| Dismiss (🧹) | Any (asks "Close it?" first) | `+isobot:cleanup` (and `+isobot:stop` if building): the runner closes the issue as not planned and cleans up |

How a click travels:

```
browser ──POST /api/actions (session + CSRF)──▶ board: actions table, state pending
runner  ──GET /api/ingest/actions every 15 s, and every push's answer──▶ pending actions
runner: re-reads the issue, applies the label change with its own token, logs board_action on the job's timeline
runner  ──next push (sent at once): actionResults──▶ board marks it done or failed; the card shows the result
```

- Only the signed-in owner can click (same allowlist), only on the runner's configured repositories, and the
  runner checks the issue's current labels itself (a closed or stopped issue is refused, an approved one is a no-op).
- One pending action per task: clicking again before the runner takes it replaces it. A click the runner doesn't
  answer within 15 minutes is marked failed ("is it running?"). Results stay on the card for 30 minutes.
- The labels are added with the runner's token (its own account), which is trusted, so the approval passes
  the pipeline's "who added it" check. Approving doesn't add `isobot:auto`, like ✅ in Discord.
- While a click waits, the page refreshes every 4 seconds; the runner pushes a fresh GitHub read with the result,
  so the card moves columns within seconds of the runner applying it.

## Agent

The agent dock talks to isobot from any view (`board/ui/agent.tsx`, `board/src/agent.ts`, `runner/src/boardChat.ts`).
Open it with **Ask isobot** in the topbar or ⌘J (on a phone, the floating button opens it as a half-height sheet over
the view). It is part of the shell, not a view, so moving around the board never ends a conversation: the thread,
the draft and the scroll stay, and the board keeps the conversation itself, so a reload or another device picks it up.
New conversations start only on purpose (＋ in the dock, or New conversation on the **Agents** view, which lists
them all as Needs you, Working, Idle and Archived).

What isobot sees with each message (the "isobot sees" strip shows it before you send):

- the URL and the view's name;
- what you **picked**: ⌥-click a PR, issue, job, task card or schedule row (long-press on a phone), or drag across
  days on a Growth line chart, which sends that range with the chart's numbers;
- the last thing you **hovered** (a row, or a day on a chart), shown as a dashed chip you can drop.

Picks stay while you move between views (to compare things) and clear once sent. The runner treats all of it as
data, and fetches fresh details with its tools by those ids.

Each conversation is one resumed Claude Code session with the staff chat's model, read-only tools and rules
(`BOARD_RULES`, the staff chat's with the board's wording). Anything that changes something is a proposal with
**Approve** and **Dismiss**, run by the same `executeAction` as a 👍 in Discord. The runner keeps its own copy of
what each proposal does; the board only says which one, and who clicked.

How a message travels:

```
browser ──POST /api/agent/messages (session + CSRF): text + page context──▶ board: agent_messages, thread queued
board   ──WebSocket the runner keeps open (/api/ingest/agent, Bearer INGEST_TOKEN): work──▶ runner
runner: one Claude Code turn; status ("github pr · 87") ──▶ board while it works; reply + proposals ──▶ board
board   ──change feed (WebSocket /api/agent/live, same-origin)──▶ browsers re-read /api/agent
browser ──POST /api/agent/decide──▶ board ──▶ runner runs it ──▶ result + note in the conversation
```

- Both WebSockets are held by the Durable Object with hibernation, so an idle connection costs nothing; pings are
  answered without waking it. The runner reconnects with backoff, and updates it made while disconnected go out
  when it's back. Without a runner connection, messages wait and the dock says so.
- A turn the runner took and never answered (it restarted) is given up after 30 minutes with a note. Proposals
  expire after a day, like the 👍 window. Archived conversations are deleted after 90 days.
- Chat turns use `chat.maxConcurrent` (default 2) separately from Discord's; `chat.enabled: false` turns both off.
- Not yet: screenshots, pins and ink, voice, and isobot issues that skip approval.

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

## Artifacts

The board can't read claude.ai, so the list is pushed to it and replaced whole each time:

```sh
node board/scripts/push-artifacts.mjs artifacts.json   # ISOBOT_BOARD_URL / ISOBOT_BOARD_TOKEN from env or runner.env
```

```json
{ "v": 1, "at": "2026-11-27T12:00:00Z", "artifacts": [
  { "title": "Health.md — iOS", "url": "https://claude.ai/artifact/…", "project": "Health.md",
    "repo": "codybontecou/health-md", "kind": "Design", "updatedAt": "2026-11-10", "pinned": false, "shared": false } ] }
```

- `POST /api/ingest/artifacts` takes it with the `INGEST_TOKEN`; `GET /api/artifacts` serves it to a session.
- Links must be `https://claude.ai/artifact/…` or `https://claude.ai/code/artifact/…`; at most 2,000 entries. A bad
  push is refused and the old list stays.
- `project` is the group heading. `repo` is a runner repository (or null), so the sidebar filter applies.
  To refresh it, ask Claude Code to list your artifacts, file them by project and run the script.

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
