# isobot runner

The runner is isobot's always-on worker. It claims approved GitHub issues,
builds them with Claude Code in isolated git worktrees, verifies and reviews the
result, opens a PR, merges when policy allows, runs release steps, and triages
new Discord, GitHub, email and App Store review activity into proposals. Design:
[architecture.md](architecture.md).

## What happens to an issue

1. You add `isobot:ready` (or create a ticket with `@isobot` in Discord).
2. Within a minute the runner swaps it to `isobot:building` and comments. The comment carries
   the runner's claim lease (see [Two runners](#two-runners)). If the issue says it waits on
   others (see [Dependencies](#dependencies)), it stays claimed and builds once they're closed.
3. A Claude Code builder implements it on `isobot/<number>-<slug>` in a throwaway
   clone and commits.
4. The runner runs the repo's `checks`. Failures go back to the builder
   (up to `maxFixRounds`).
5. A separate read-only Claude Code reviewer judges the diff. Change requests go
   back to the builder (up to `maxReviewRounds`). When the repo can merge, so does
   an approval that misses the merge bar (confidence below `minReviewConfidence`,
   or high risk): the builder gets the reviewer's concerns and another round,
   sharing the same `maxReviewRounds` budget.
6. The runner pushes and opens a PR with the summary, check results and review.
7. If every gate passes and the repo's autonomy is `merge`, it waits for GitHub
   CI, re-checks the gates, and squash-merges exactly the reviewed commit.
   Otherwise it labels `isobot:review` and explains why. The CI wait is a follow-up
   (below), so the build slot goes to the next job while CI runs.
8. After a merge (by isobot or by you): `release.onMerge` commands run. If the
   repo has `release.onShip`, the issue waits for you to add `isobot:ship`.

Add `isobot:stop` at any time to stop. A failed issue gets `isobot:failed` and
a comment. To retry, reply `retry` (or "try again") in the job's Discord thread or on
the issue, run `npm run runner -- retry time.md#12`, or add `isobot:ready` again.

## Setup on a Mac

```sh
npm ci --prefix runner
mkdir -p ~/Library/Application\ Support/isobot
cp runner/runner.env.example ~/Library/Application\ Support/isobot/runner.env
# fill in runner.env, then:
npm run runner -- doctor     # checks Claude Code, GitHub, Pi
npm run runner -- setup      # creates the isobot labels in each repo
npm run runner -- triage     # optional: one triage pass now
runner/launchd/install.sh    # run forever under launchd
```

The first triage pass of each source only records where to start, so isobot
doesn't propose your whole backlog.

## Operating it

| Command (`node runner/dist/main.js …` or `npm run runner -- …`) | Does |
| --- | --- |
| `status` | Whether the runner is alive (heartbeat), what it's building, pauses, recent jobs |
| `pause` / `resume` | Stop or restart claiming new work |
| `once` | Build whatever is approved right now, then exit |
| `triage` | One triage pass, printed as JSON |
| `doctor` | Configuration, connectivity, sandbox and heartbeat checks |
| `say <repo#n> <text>` | Send isobot a note about a job, as if you'd replied in its Discord thread |
| `retry <repo#n> [note]` | Build an issue again (failed, merged, closed or stopped job, or one never built), optionally with a note for the builder |
| `inspect [repo#n] [--follow] [--json]` | Timeline of what isobot did, across jobs or for one, and what it will check next. `--follow` keeps printing new events |
| `grants [repo]` | Who may approve, stop, merge, chat and hand off, and each repo's merge rules, gathered from config and `runner.env` |
| `cloud-smoke <repo> [--checks]` | One real build in a Cloudflare build sandbox, never pushed ([cloud builds](cloud-builds.md)) |
| `aso <repo> snapshot \| report \| research [--dry-run]` | Read an app's ASO Tracker board, post its weekly rank report now, or draft and measure a listing proposal ([ASO train](aso.md)) |
| `aso <repo> pending \| approve \| reject \| apply` | Show, approve or dismiss an app's latest listing proposal, or write an approved one to App Store Connect now ([ASO train](aso.md#applying-a-proposal)) |
| `release <repo#n>` | Run a merged job's `release.onMerge` again, e.g. one a restart interrupted. The running runner does it on its next pass |

Logs: `~/Library/Application Support/isobot/logs/runner.log` (rotated at
10 MB, three kept). State: `runner.sqlite` and `heartbeat.json` beside it.
Workspaces are removed after each job and on start; clones in `repos/` are reused.

## Discord

With `ISOBOT_DISCORD_BOT_TOKEN` and `ISOBOT_DISCORD_CHANNEL_ID` in `runner.env` (the bridge's bot,
in your staff channel), each job gets **one status card** in the channel. The runner edits it as
the job moves (Build → Checks → Review → PR → Merge → Release → Ship), with fix and review rounds,
how long it's been running, and Issue / PR buttons. The detail goes in a **thread under the
card**: the builder's summaries, check results, the review verdict, why isobot left the merge to
you, release output. Runner-wide messages (started, cycle failing, usage-limit pause, triage
digests) stay in the channel. With only `ISOBOT_DISCORD_WEBHOOK_URL`, you get the old one-line
messages and no threads.

**One-click controls.** isobot adds reactions you can click (only allowlisted users count; the bridge
turns each into a label change with your GitHub token; ✅ and 🛑 are toggles and reacts 🏗️ or 👌 when it lands, 🚫 if the
issue is closed or stopped):

| React | On | Does |
| --- | --- | --- |
| ✅ start | triage digests, help-thread posts, job cards | adds `isobot:ready`; removing it before the runner claims the issue withdraws it |
| 🛑 stop | job cards (any message about one issue) | adds `isobot:stop` (and withdraws a pending `isobot:ready`). It's a toggle: un-clicking it while the stop is in place continues, like 🔁 |
| 🔁 continue | job cards | one-shot: lifts `isobot:stop`; on a failed or stopped job, adds `isobot:ready` to build it again |
| 🧹 clean up | triage digests, job cards | one-shot (un-clicking does nothing): adds `isobot:cleanup`: on its next pass the runner removes the issue's leftover workspaces, DerivedData and branch refs, strips isobot's labels, comments and closes the issue as not planned. An open PR is left alone. |

A digest with one proposal awaiting approval gets ✅ 🧹 on itself; with several, each gets a short
message of its own (the bridge only acts on messages about exactly one issue). A running build
notices 🛑 (or the 🛑 that 🧹 adds) at its merge gate, as with the label; the cleanup waits for it.

**💻 Continue on the Mac.** Job cards, posts in job threads, triage digests and proposals, other
channel notices and staff-chat answers also get a 💻. Tap it and the runner opens a new, focused tab in
your local Herdr, with Claude Code already in the conversation:

| Tapped on | Opens |
| --- | --- |
| a job card or a post in its thread | the builder's Claude session, resumed as a fork (`claude --resume <id> --fork-session`). It runs in the job's workspace when that's still on disk and nothing is building there; otherwise in the repo's local checkout, so it never edits files under a running builder |
| a staff-chat answer | that chat thread's session, resumed as a fork |
| anything else (a digest, a notice) | a new Claude Code session that gets the message as context, framed as data because digests quote other people, and waits for you |

The tab goes in the repo's Herdr workspace (matched by its checkout or its label, e.g. `health-md`), in
its checkout (or `~/dev/<repo>`); everything else goes to the `isobot` workspace in `~/dev`. A fork leaves
the original session alone, so the chat or build carries on in Discord as before. The runner does this, not
the bridge, because only the runner is on the Mac with Herdr: it polls the channels it put a 💻 in (one
request per channel every 8 seconds, every 30 or so once a channel has had no new 💻 for half an hour; messages that have scrolled past a channel's latest 100 are
checked a few at a time) and only acts on allowlisted users (`ISOBOT_CHAT_USERS`, as for the staff chat).
After opening the tab it takes your 💻 back off so the button is ready again; that needs **Manage
Messages** for the bot in those channels. Without it, un-react and react again to open another tab. If
Herdr isn't running, isobot reacts ⚠️ and logs why. It's on whenever the bot is configured and `herdr` is on the runner's PATH;
configure it under `handoff` in the runner config: `enabled: false`, `herdrBin`, `workspace` (default
`isobot`), `cwd` (default `~/dev`). `runner doctor` checks that Herdr answers. Cards posted before this
existed get their 💻 on their next update.

**Talking back.** Reply in a job's thread. The bridge relays replies from allowlisted users
(`ISOBOT_ALLOWED_USERS`, or the bot's owner) to the job's GitHub issue and reacts 📨. The runner
treats your comments on the issue as **notes**, wherever they came from: the thread, the issue
itself, or `npm run runner -- say time.md#12 "use the system font"`.

- **While it builds**, a note goes to the builder (same Claude session) before the next check or
  review round, at most five per build. The task the reviewer sees includes your notes.
- **On an open PR**, a note queues a revision: the runner checks out the PR branch, resumes the
  builder's session with your note, re-runs checks and review, and updates the same PR. If the
  repo merges automatically, a note that hasn't been applied yet blocks the merge. Every
  revision first merges the newest main into the branch; on a conflict the builder resolves it
  (regenerating built files such as sitemaps) before the usual checks and review.
- **Left behind by main**: when another PR merges first and this one now conflicts, GitHub runs no
  CI on it and refuses the merge. Instead of counting that as missing CI, the runner queues a
  revision to merge main in, up to twice per job (`MAX_MAIN_ROUNDS`); after that the gate decides
  as usual.
- **After it's merged, closed or failed**, a note that starts with `retry`, "try again", "rebuild"
  or "build it again" builds the issue again: the runner adds `isobot:ready` itself and every note
  since the first approval goes to the builder ("try again, and use the system font" works; a bare
  "retry" isn't passed on). Any other note gets told how to continue. This covers jobs that
  finished in the last 48 hours; for older ones use `runner retry`. A retry never adds
  `isobot:auto`, so the issue keeps the autonomy it had.

Only comments written by your account (or `trustedAuthors`) count. The runner's own comments,
triage proposals and relays of community `#help` threads never do. The bridge posts with its
`GITHUB_TOKEN`, so that token must belong to you (or a `trustedAuthors` account); otherwise the
thread says the reply was ignored. Set `ISOBOT_RUNNER_CHANNEL_ID` on the bridge to only relay
from that channel.

## Staff chat

Mention isobot in the staff chat channel (`ISOBOT_CHAT_CHANNEL_ID` in `runner.env`; without it,
the job-card channel) and it answers in a thread. Mention it anywhere else in the server and it
reacts 💬 where you asked and answers in a new thread in the staff channel that pings you and links
back. Nothing is posted in public, contributor or support channels, because the answers can carry
private context (logs, private repositories, email triage). Whatever you replied to comes along, so
"@isobot is this a known bug?" in reply to a community message works. Keep
talking in that thread without mentioning it; each thread is one Claude Code session that
remembers the conversation. In the staff channel, replying to any of isobot's messages works like a
mention (reply to a job card to ask about that job), and so does talking in a thread you opened on
one of its posts, such as a triage summary: it answers in that thread, with the post as context. In
any other staff-channel thread, mention it and it joins there. Job-card threads are the exception:
replies there are notes to the build, so ask about a job by replying to its card instead.
Attach screenshots or logs and it reads them.

- **Ask anything:** status, what needs you, why a build failed or a gate refused a merge, what a
  PR changes. It reads jobs, issues, PRs and diffs, the runner log and repository policy, and it can
  check out any configured repository to read and grep the code. "Why does export crash?" gets an
  answer from the code.
- **Act:** it proposes actions and does nothing until you confirm. Each proposal is its own message
  spelling out exactly what will happen; react 👍 to run it or 👎 to cancel (proposals expire after
  24 hours). The runner, not the model, carries out the confirmed action:

  | Say | Proposal | On 👍 |
  |---|---|---|
  | "file this", "write the code for this" | create_issue (with build) | opens the issue; with build, adds `isobot:ready` and `isobot:auto`, so the usual build, checks, review and PR follow (and `ownerAutonomy` applies) |
  | "build #12", "try #12 again" | build | adds `isobot:ready` and `isobot:auto` |
  | "tell #12 to use the system font" | note | an owner note on the issue, same as replying in the job's thread |
  | "merge PR #40" | merge | squash-merges exactly the commit that was proposed, only if CI isn't failing or pending; release steps follow on the next pass |
  | "ship #12" | ship | adds `isobot:ship` to a job waiting to ship (App Store / Google Play step) |
  | "stop #12" / "pause" / "resume" | stop / pause / resume | the stop label, or pauses / resumes the whole runner |
  | "submit 3.0.1 for review", "reply to that review", "release it" | asc | runs the exact `asc …` command shown in the proposal |
  | "make a private #vox-inbox channel in staff", "add an overview channel to Whereday" | create_channel | creates it; inside a category it gets the category's permissions, `private` hides it from @everyone |
  | "add a THUMBLE category" | create_category | creates it, optionally private |
  | "rename #chat to #feedback", "move #updates into STAFF", "set the topic" | edit_channel | renames, sets the topic, or moves it; a moved channel takes its new category's permissions (the proposal says whether that's private) |
  | "give #vox-inbox a webhook" | create_webhook | creates it and saves its URL to `webhooks/<channel>-<name>.url` in the runner's home (mode 600), never posting it |

- **App Store Connect:** it reads App Store Connect with the runner's `asc` CLI (review and submission
  state, builds, TestFlight, customer reviews, metadata, sales and analytics) with `ASC_READ_ONLY=1`,
  so asc itself refuses any change. Changes are `asc` proposals: the confirmation shows the literal
  command, and only commands for versions, localizations, metadata, builds, build localizations,
  TestFlight, review, customer reviews, submit, release, release notes, in-app events and Xcode Cloud
  are allowed. Users, keys, signing, certificates, pricing and raw API calls are never allowed.
  Arguments starting with `@` (asc's `@file:` / `@env:` expansion) and flags that take files, paths or
  keys or switch profiles are refused, so text planted in an issue can't copy a local file or secret
  into App Store metadata. Builders and checks can't read `~/.asc` (asc's config); release and ship
  steps, which run unsandboxed, still can.

- **Discord server:** it lists the server's categories and channels (which are private, their
  topics and ids) and proposes the changes above. Every proposal is checked against the server as it
  is (duplicate names, missing or ambiguous channels; name one as `category/name` or by id) and
  checked again on 👍. A private channel can't be moved into a public category, where it would show to
  everyone. Nothing can be deleted, and roles, members and server settings are out of
  reach. Webhook URLs are runner secrets: `webhooks/` is off limits to builders, checks and the chat
  model like `runner.env`. The bot needs Manage Channels (and Manage Webhooks for webhooks); to make
  a private channel it must be able to see it, so give it Administrator or an allow on the category.

- **Daily check-in:** at `chat.checkInHour` (local time; 9 by default, `null` for none) the
  channel gets a summary of what needs you: PRs to review, jobs ready to ship, failures this week,
  proposals awaiting approval, and, with [App Store analytics](analytics.md) on, a line per app with
  its latest day's numbers, and with the [crash audit](crashes.md) on, a **Crashes** section. Nothing is posted
  on a day with nothing to say; an analytics flag (downloads jumping or dropping, a churn spike, reports that
  stopped arriving) or a crash flag (a spike, a new crash group in the latest release) counts as something to say.

Who can talk to it: `ISOBOT_CHAT_USERS` (comma-separated Discord user ids), else
`ISOBOT_ALLOWED_USERS`, else the bot application's owner. Everyone else is ignored, and only their
👍 counts. With the chat on, the bridge no longer turns mentions into tickets or answers anyone
else's mentions; ask the chat to file it instead. The model runs with Read, Grep and Glob limited to `chat/` in the runner's home
(checkouts and your uploads), plus isobot's own tools served from inside the runner on 127.0.0.1;
it never sees the runner's tokens, your other MCP servers or a shell. Everything it reads from
issues, reviews, email or code is treated as data, and because every action needs your 👍 on a
message that spells it out, text planted in an issue can at most suggest something you decline.

Configure it under `chat` in the runner config: `model` (default `sonnet`), `checkInHour`,
`maxConcurrent` (turns at once, default 2), `timeoutMinutes` (default 15), `maxTurns` (default 40),
`enabled: false` to switch it off. The bridge leaves mentions to the runner when its
`ISOBOT_CHAT_CHANNEL_ID` secret is set to the same channel id
(`npx --prefix bridge wrangler secret put ISOBOT_CHAT_CHANNEL_ID`). The bot needs View Channel,
Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Add
Reactions and Attach Files there, and View Channel, Read Message History and Add Reactions wherever
you want to mention it. The runner finds new messages by reading the server's channel list and active
threads every 5 seconds, then only the channels that changed.

## Follow-ups

Some steps wait on the outside world: GitHub CI on a PR, or another issue closing. The runner
doesn't sleep inside the build for those. It saves a follow-up in `runner.sqlite` (job, what to
check, when) and checks the ones that are due on every cycle. So:

- **A PR waiting for CI holds no build slot.** The job shows as `awaiting_ci`; the next job
  starts. CI is checked every 30 seconds. "No CI" is final after 5 minutes, and after 90
  minutes of pending the PR is left to you. When CI settles, the gates run again on the issue
  as it is then, and isobot merges (and releases) or hands the PR to you.
- **A restart loses nothing.** Follow-ups are in SQLite, so a runner restarted while a PR waits
  for CI carries on waiting instead of reviewing again.
- A follow-up that keeps erroring is retried every 5 minutes; after five non-temporary errors the
  job fails with the reason.

`status` and `inspect` list what's pending and when it's next checked. 🧹 or the stop label ends
a wait like it ends a build.

## Dependencies

Put a line in the issue body to make it wait on other issues:

```
Blocked by #12
Depends on codybontecou/health-md#7 and https://github.com/codybontecou/vox.md/issues/90
```

Lines starting `Blocked by`, `Depends on` or `Waits on` count (a list bullet or bold is fine);
other mentions of `#12` don't. When you approve such an issue, isobot claims it straight away
(state `blocked`, card "Waiting on another issue") and checks every 2 minutes. Once every issue
it names is closed, it queues the build. So you can approve a chain at once and each step
starts when the one before merges. Editing a blocker out of the issue takes effect on the next
check. An issue isobot can't read (wrong repo, no access) counts as still open, and the card
says so. A closed issue counts as done however it was closed.

## Two runners

Each runner has a name, `ISOBOT_RUNNER_ID` in `runner.env` (default: the host name). Its claim
comment carries a lease, `<!-- isobot:lease runner=<name> until=<time> -->`, valid for 45
minutes and renewed while the job is queued, blocked, building or waiting for CI. A runner that
dies stops renewing, and its lease lapses.

- An issue with `isobot:building` and another runner's live lease is left alone: that runner
  removes the ready label and comments that `<name>` has it. Approve it again once that build is
  done.
- Two runners that claim the same approval at the same moment both post a lease, read the
  issue again, and the earlier comment wins; the other forgets its job.
- Only leases written by the runner's own GitHub account count, so nobody can block builds by
  pasting a marker.

This matters while moving to the Mac mini, or with a laptop and the mini both running. With
one runner it costs one extra comment read per claim and a comment edit every ~25 minutes per
long job.

## When things go wrong

- **Temporary problems** (network, GitHub outages, Claude overload) put the
  issue back in the queue with backoff (5 min, 15 min, 45 min, 2 h) and one
  comment; after five attempts it's marked `isobot:failed`.
- **Claude usage limit**: all builds pause until the limit resets (or an hour),
  without using up attempts. `status` shows the pause.
- **Any temporary problem after the builder committed** keeps that commit: the retry runs checks and review on
  it again instead of building from scratch (`♻️ Trying again after a temporary problem`).
- **A job device that stopped mid-job** (an idle reaper, memory pressure, someone shutting it down): before every
  check run the runner asks each leased simulator and emulator whether it is still up, and boots whatever isn't.
  When checks fail and a device turns out to have gone under them, the checks run again on the revived device
  instead of sending the builder to fix code that isn't broken (no fix round used). After two such reruns the job
  retries later, keeping the builder's commit. The timeline shows `devices booted again`. The Mac's `devicepool`
  watchdog never reaps `isobot-job-*` AVDs or `isobot-*` simulators while the runner's heartbeat is fresh.
- **Already done**: a builder that finds the issue already done on the default branch (typically a crash fixed by
  other work and not yet released) makes no changes and says `Already done:` with the commit or code that does it.
  The issue then closes as completed with that explanation, instead of `isobot:failed`. Reopen it and comment
  `retry` if it isn't.
- **Claude Code signed out**: treated as temporary; `doctor` says so.
- **Restart, crash or reboot**: launchd restarts the runner, and interrupted builds
  pick up where they were. On startup, before clearing workspaces, the runner commits
  whatever each interrupted build left uncommitted and queues it to continue from that
  commit: a builder that was mid-run resumes the same Claude Code session (its id is
  chosen and saved before the run starts) in the same workspace path, with new devices.
  A build that was in checks or review runs them again without rerunning the builder
  (a PR waiting for CI just keeps waiting: see [Follow-ups](#follow-ups)).
  Captures it already made are kept. A deliberate stop (SIGTERM) doesn't use up one of
  the job's attempts. If the workspace is gone (a reboot cleared it) or the session is,
  the build starts over from the task and the saved commit, or from scratch. So you can
  restart the runner to deploy a change without draining the queue first.
- **Restarts and side effects**: merges and release steps go in an effect ledger
  (`effects` in `runner.sqlite`), recorded before a step runs and after it finishes.
  - A build whose PR is already merged (isobot merged it just before a restart, or you
    merged it while a revision waited) isn't built again. It carries on from the merge,
    so there's never a second PR.
  - A release that never started after a merge runs on the next pass.
  - A release that was running when the runner stopped may have partly happened. It
    runs again by itself only if the repo sets `release.replaySafe`. Otherwise you get
    one comment, and it waits for `npm run runner -- release <repo#n>`.
  - A ship step a restart interrupted is never rerun by itself. You're told once, and
    adding `isobot:ship` again runs it.
  - A restart isn't reported as a failed release or ship step, or as GitHub refusing a
    merge.
- **The whole Mac goes away** (asleep, offline, powered off): the runner POSTs to
  `ISOBOT_HEARTBEAT_URL` every minute while it is healthy (last cycle succeeded, current
  one under 2 hours). The `watchdog/` Worker (`isobot-watchdog`, deploy with
  `npm run watchdog:deploy`) receives them at `/ping/<PING_TOKEN>` and posts to the
  runner's Discord webhook after 10 minutes of silence (`GRACE_MINUTES`), every 6 hours
  while it stays quiet, and once when pings resume. `GET /status/<PING_TOKEN>` shows the
  last ping. It runs on Cloudflare, so it still works when this Mac doesn't; any
  dead-man's-switch URL that accepts a POST works too. `doctor` sends a test ping.
- **Sleep**: while a build runs the runner holds a `caffeinate` assertion, so
  the Mac doesn't idle-sleep mid-build.

`npm run smoke --prefix runner` runs a complete build (real Claude Code, real
git, real checks) against a throwaway local repository and an in-memory GitHub,
which is the quickest way to confirm a new machine works.

## Configuring a repository

Edit `runner/config/isobot.json` (policy deliberately lives here, not in the
target repo):

```json
"codybontecou/time.md": {
  "autonomy": "merge",
  "checks": ["make test"],
  "notes": "SwiftUI app; run make lint before committing.",
  "release": {
    "onMerge": ["fastlane beta"],
    "onShip": ["fastlane release"]
  }
}
```

Release commands run on a clean checkout of the merge commit with the runner's
scrubbed environment, so tools that need credentials (App Store Connect API
keys, Wrangler) must find them in their own config on the machine.

Add `"replaySafe": true` under `release` when running `onMerge` twice on the
same commit is harmless, as with a Worker or site deploy. Then a release a
restart interrupted runs again by itself. Leave it off for anything that bumps
a build number or uploads a binary (TestFlight): a second upload of the same
build fails or duplicates.

Every configured repository currently runs at `"autonomy": "merge"` (set in
`defaults`): isobot merges any trusted issue once every gate passes. Issues
written by someone outside `trustedAuthors` still never merge without you.

## End to end for your own work

A repository can give your own work more autonomy than community reports with
`ownerAutonomy` (no repository needs it while `defaults.autonomy` is `merge`):

```json
"codybontecou/vox.md": { "autonomy": "pr", "ownerAutonomy": "merge", "checks": ["./scripts/test-project-contracts.sh"] }
```

Work counts as yours when the issue has `isobot:auto` **added by your account**.
The runner adds it to proposals it auto-approves from your Vox.md notes. Add it
yourself to an issue you write. A collaborator or bot adding it changes nothing,
and removing it at any point (or adding `isobot:stop`) drops back to `autonomy`.
Every merge gate still applies: runner checks, the reviewer, GitHub CI,
protected paths and unchanged issue text. `ownerAutonomy: "merge"` needs
checks, like `autonomy: "merge"`. After an automatic merge, `release.onMerge`
runs, and `release.onShip` still waits for `isobot:ship`.

## Vox.md notes

Your own voice notes can feed triage directly. In Vox.md, make a capture preset
(e.g. **isobot**) with **Destination → Target → HTTP**:

- URL: `https://pi.isolated.tech/api/vox?mode=memory&conversation=isobot`
- Bearer Token: the raw `PROMPT_API_TOKEN` from `.env.prompt`

Use `mode=memory`: the note is stored without Pi running a model on it. Each
triage pass reads new notes from that conversation (the `vox` block in
`runner/config/isobot.json`), splits a rambling note into up to
`maxProposalsPerNote` concrete changes, and ignores errands, games and
open-ended ideas. `hints` tells the model how product names come out of
speech-to-text.

With `autoApprove: true`, proposals at or above `minAutoApproveConfidence`
(default 0.7) are filed as `isobot:ready` plus `isobot:auto` and build immediately; less certain
ones wait as `isobot:proposed`. Only the `vox` source can self-approve, and repo
autonomy still decides whether a PR merges. Add `isobot:stop` to cancel one.
Because the conversation exists only for isobot, the first pass takes notes that
were already there. Notes arrive at the next triage pass (`triageMinutes`).

## App Store reviews

`appStore` in `runner/config/isobot.json` maps App Store app ids to repositories and lists the
storefronts to read. Each triage pass reads Apple's public customer-reviews feed (newest 50 per
storefront; no App Store Connect key), so only reviews with written text show up, not bare star
ratings. The first pass only records where each storefront stands; after that every new review goes
to triage. Reviews of 3 stars or fewer, or any review describing a bug, crash or missing feature,
become proposals when they are concrete enough to act on; the Discord digest also lists every
review of 2 stars or fewer. Proposals in public repos never name the reviewer.

To add an app, find its id in its `apps.apple.com/.../id<digits>` link and add it under
`appStore.apps`. Replying to reviews would need an App Store Connect API key; the runner doesn't do it.

## Approval by scope

Triage rates every proposal `small` or `major`. Small means a bug fix or a contained feature that
fits the app as it is; major means redesigns, new screens or flows, data-model changes, anything
touching purchases, sign-in, privacy, permissions, tracking, new services or dependencies, and
anything uncertain. With `autoApprove` set (sources, kinds and a minimum confidence), small
proposals are filed with `isobot:ready` and `isobot:auto` and go end to end; major ones always wait
for you to add `isobot:ready`. Your Vox.md notes follow `vox.autoApprove`, but major ones wait too.

A stranger's GitHub issue that isobot approved this way builds from isobot's own proposal comment,
never the reporter's text, so it may merge like your own work. Every merge gate still applies:
checks, the reviewer, protected paths, CI, and an unchanged issue.

## Release train

A repo with `train` in its policy ships merged isobot work to the App Store (or to TestFlight, below):

1. When merged jobs are waiting, the last train left at least `everyHours` ago, and no version is
   in App Review (`asc status`), the runner opens a **Ship x.y.z** issue listing the changes and
   their What's New text, and posts it to Discord.
2. `holdMinutes` later, unless that issue has `isobot:stop` or was closed, it runs `prepare`, then
   `asc publish appstore`: archive, upload, attach What's New, submit for review. The version is
   the App Store's current one with the patch bumped; the build number is a UTC timestamp.
3. On success the commit is tagged `v<version>`, the jobs become `shipped`, their issues hear about
   it, and the ship issue closes. On failure the output goes on the ship issue and the work waits
   for the next train.

A repo's first train waits for you to add `isobot:ready` to its ship issue. Later trains don't.

### TestFlight instead of the App Store

Add `testflight` to a train to send each build to external testers instead of App Review:

```json
"train": { "...": "...", "testflight": { "group": "Public beta", "joinUrl": "https://testflight.apple.com/join/XXXXXXXX" } }
```

Step 2 then runs `asc publish testflight`: archive, upload, add the build to that external group,
set What to Test (the same model-written text as What's New) and submit it for Beta App Review.
Nothing is submitted to App Review, so App Store state doesn't hold the train. A build still waiting
on Beta App Review holds the next one. The version is the App Store's current one with the patch
bumped, or the newest uploaded build's version if that is already ahead (an open 4.0.0 beta while
3.5.0 is live), so builds pile up under it until you release one yourself. Each build gets a timestamp build
number and a `testflight/<version>-<build>` tag. Testers get TestFlight's own update notification.

With `launch` set, the post goes out once the build reaches external testers (`IN_BETA_TESTING`),
titled as a beta, with `joinUrl` (the group's public link) in place of the App Store link. Without
`joinUrl` it tells existing testers to update. A rejected or expired build gets no post, and the
staff channel hears about it.

GitSync.md, Health.md, Whereday and Vox.md trains ship to TestFlight, and their weekly production release
(below) puts the tested builds on the App Store.

### Weekly App Store release

Add `production` to a TestFlight train to send its builds to the App Store once a week (`runner/src/production.ts`):

```json
"train": { "...": "...", "testflight": { "...": "..." }, "production": { "weekday": 2, "hour": 10, "minBetaHours": 48, "holdHours": 4 } }
```

1. On `weekday` (0 = Sunday, default Tuesday) at `hour` (local, default 10:00), the runner picks the newest TestFlight
   build the train uploaded that external testers have had for `minBetaHours` (default 48), that TestFlight still
   shows as installable, and whose version is ahead of the App Store. Nothing may be in App Review; if something is,
   or the runner was down, the week's release goes as soon as it can. With no such build, the staff channel hears
   so once and the week is skipped.
2. A **Release x.y.z to the App Store** issue lists every change since the last App Store release and the
   model-written What's New, and is posted to Discord.
3. `holdHours` later (default 4), unless the issue has `isobot:stop` or was closed, the runner stages the version
   from that exact build (no new archive: the binary is the one testers had), copying the live version's metadata
   and setting What's New in every locale, sets it to release once approved, **turns on a 7-day phased release and
   checks it exists**, then submits it for App Review. If the phased release can't be confirmed, nothing is submitted.
4. The changes' issues hear about it, the release issue closes, and with the train's `launch` set the launch post
   goes out once the version is live. Set `"announce": false` where another service already announces App Store
   releases (Health.md, whose iOS releases `asc-webhook-worker` posts).

A repo's first weekly release waits for you to add `isobot:ready` to its release issue. Later ones don't.
Only builds uploaded after this shipped are on record, so the first week after deploying passes quietly.
A failed step leaves the work for next week and says on the issue which step failed; a half-staged version
may be left in App Store Connect to fix or delete. Pausing, resuming or finishing a phased rollout early is
still yours (`asc versions phased-release update`).

### Release notes and launch posts

When a train is announced, the model rewrites the shipped changes (issue titles and PR descriptions)
into notes for users: a headline, what's ✨ new, 🐛 fixed and 💅 improved, and the App Store's
What's New. Internal-only changes are left out, and links and mentions are stripped. The ship issue
shows both during the hold, so close it or add `isobot:stop` if the wording is wrong. If the model
is unavailable, What's New falls back to the bullet list of issue titles.

Add `launch` to a train to tell users when a version is out:

```json
"train": { "...": "...", "launch": { "channelId": "<the app's Discord channel id>", "name": "Voxboard" } }
```

Once the App Store shows the submitted version as `READY_FOR_DISTRIBUTION` (the runner checks every
15 minutes), the bot posts the notes to that channel, with an App Store link and one capture from
each change: the builder's screenshot, or a recording when there's no screenshot. Captures over
Discord's 10 MB limit are skipped, and a post too long for one Discord message leaves out its last
items (never the App Store link). The staff channel gets a note that the post went out. A version
that never goes live, or that a later version replaces, gets no post. `name` defaults to the
scheme and `storeUrl` to `https://apps.apple.com/app/id<appId>`. Launch posts need the Discord bot;
a webhook alone can't post to another channel.

For GitSync.md, Whereday (the iso.me channels) and Vox.md, the train posts in each app's `#updates`, and
`asc-webhook-worker` (which announces every other App Store release from Apple's webhooks) skips
their iOS releases via `skipPlatforms`. An iOS version of those apps released outside the train
gets no post; Vox.md's Mac releases are still the worker's.
The runner uses the App Store Connect key `asc` already has in the keychain, and signs with this
Mac's keychain, so it must run as a user who can archive and sign the app in Xcode.

## Content train

A repo with `content` in its policy gets website content written for search, every day, by the
content train (`runner/src/content.ts`). Health.md (healthmd.app), GitSync.md (gitsync.md), Whereday
(whereday.com) and Vox.md (vox.isolated.tech) run it at three pieces a day each.

1. **Research.** `perDay` times a day, spread evenly over `content.hours` (06:00–22:00 by default),
   a Claude run reads the site in a fresh checkout of main and the site's OpenSEO project: its
   context and research log, 28 days of Search Console data, and keyword, SERP and competitor
   tools within `maxCreditsPerRun`. It picks one piece of work: a new post, guide or tutorial, a
   small free browser tool, or a refresh of a page that already gets impressions. It skips when
   nothing is worth doing, and holds back while three or more content issues are still open.
2. **Issue.** The brief becomes an issue labelled `isobot:content`, `isobot:ready` and `isobot:auto`,
   and 📝 goes to the staff channel. The repos are public, so the brief has no Search Console numbers:
   those stay in the runner's store and reach the builder through the task.
3. **Build and merge.** The usual build, checks, review and gates, under the site's content policy
   (`contentPolicy` in config.ts) instead of the app's. Content runs end to end with no person in the
   loop, so nothing it builds waits for one:
   - checks are `content.checks` (the site's build and tests); the repo's simulators and emulators are
     still booted, so walkthroughs are checked and screenshotted in the real app;
   - every changed file must match `content.allowedPaths`. The builder sees the list in its task, and
     before review it gets up to two rounds to take back any file outside it or protected;
   - protected paths are CI, deploy and secret configuration, agent instructions and package manifests,
     not the app's list (whose `**/*premium*` and the like match ordinary post slugs);
   - `requireCi` is `content.requireCi` (default off), and there are no release or ship steps;
   - the builder and reviewer get the content standard: claims about the app checked against its
     source, primary sources for other products, no duplicate pages, links both ways, the site's
     conventions (`content.notes`), and a `Published URLs:` line at the end of the summary. What
     can't be verified is left out instead of flagged. In cloud builds the builder screenshots its
     pages in headless Chromium at 390 and 1280 px and validates XML output with `xmllint`;
   - the reviewer judges it as an editor (`CONTENT_REVIEW_RULES` in builder.ts), with WebFetch and
     WebSearch to open the cited sources. An unsupported claim is a concern the builder must source or
     cut. "Needs a real browser", machine translations the site marks for later review, and shared
     boilerplate are not held against it. Blockers are only for what the owner alone can decide;
   - the merge bar is `content.minReviewConfidence` (default 0.75), not the repo's `minReviewConfidence`;
   - **a piece that still fails a gate after its rounds is dropped**, not left for you: the PR closes,
     the issue closes as not planned with the reasons, and the next research run sees why (the recent
     jobs list shows `dropped: …`) so it doesn't propose the same thing. The weekly report counts drops.
     Holds that are yours stay yours: `isobot:stop`, a note isobot hasn't applied, an edited or closed issue.
   Content merges with `content.autonomy` (default `merge`) and never rides the release train.
   At most `content.maxConcurrentJobs` (default 1) content builds run at once, so app work isn't held up.
4. **Publish.** Once the site's newest successful production deploy contains the merge commit
   (`content.deploy`: the push runs of a workflow such as `website-publish.yml`, or a GitHub
   deployment environment such as Vercel's `Production`), and every published URL answers 200, the site's `indexNow`
   command runs with the URLs (or OpenSEO's IndexNow when there is none), the OpenSEO research
   log gets one line, and the job's thread hears about it. A merge no deploy has shipped, or pages not
   live, 3 hours after the merge are reported instead. Checking the deploy matters for refreshes: an
   existing page answers 200 before its new text is out.
5. **Weekly report.** On `content.reportWeekday` (Monday by default), each site's Search Console
   picture goes to the staff channel: clicks and impressions week over week, movers, how the week's
   pages are doing, refresh candidates and anything broken. It uses only free tools.

**Credits.** Each research run reports the OpenSEO balance before and after. Research stops for the
day at `maxCreditsPerDay` (default 1500), and stops entirely below `minCreditsRemaining`
(default 300), with one ⏸ message a day saying so. Builders can't use OpenSEO at all (the builder
settings deny `mcp__plugin_openseo_openseo`); only the research, publish and report runs may, with
a fixed list of tools. None of them can delete anything or change OpenSEO schedules and trackers.

Run one now with `npm run runner -- content <repo> research` (files an issue; add `--dry-run` to print the brief and file nothing) or
`npm run runner -- content <repo> report`. To stop a site, set its `content.autonomy` to `off`
(or `pr` to review every post yourself; nothing is dropped then). To stop one post, add `isobot:stop`
to its issue. To build a dropped piece again, reopen its issue and comment `retry`.

```json
"content": {
  "site": "healthmd.app",
  "openseoProjectId": "a62f2923-…",
  "perDay": 3,
  "allowedPaths": ["apps/website/**"],
  "checks": ["npm --prefix apps/website ci && npm --prefix apps/website run build"],
  "indexNow": "node apps/website/scripts/submit-indexnow.mjs",
  "notes": "Posts go in apps/website/content/blog/<slug>.md …"
}
```

Runner-wide limits go under the top-level `content`: `maxConcurrentJobs`, `maxCreditsPerRun`,
`maxCreditsPerDay`, `minCreditsRemaining`, `reportWeekday`, `hours`.

## ASO train

Each App Store app with an `aso` block gets a daily snapshot of its App Store search ranks from the local
ASO Tracker, a weekly rank report in the staff channel, and a weekly listing proposal (name, subtitle, keywords,
promotional text) that ASO Tracker has measured. Proposals go only to the staff channel, and nothing is written
to App Store Connect. See [ASO train](aso.md).

## App Store analytics

With `"analytics": {}` in the runner config, the runner downloads Apple's App Store Connect analytics
for every app in `appStore.apps` every 6 hours, read-only, and keeps a record per app and day. The daily check-in,
the weekly ASO report and the staff chat's `app_analytics` tool read it. See [App Store analytics](analytics.md).

## Crash audit

With `"crashes": {}`, the runner reads Google Play's crash and ANR clusters, Apple's App Crashes report and
TestFlight crash submissions every 6 hours, files each new crash group that affects enough users as an
`isobot:proposed` bug in the app's repo, and adds a **Crashes** section to the daily check-in. See
[Crash audit](crashes.md).

## Play rollouts

With `"playRollout": {}`, the runner moves staged Google Play production rollouts forward on its own (20% for 2 days,
50% for 5, then everyone) and halts one when the new version brings crashes. See [Play rollouts](play-rollout.md).

## Builder sandbox

Builders run with Claude Code's shell sandbox on. It allows writes to the
workspace, the temp directory and common toolchain caches (DerivedData,
CoreSimulator, SwiftPM, npm, Gradle…), and blocks reads of credential folders
and runner state. If a build needs another location, add it under
`builder.settings.sandbox.filesystem.allowWrite` in `runner/config/isobot.json`.
Builders don't get your global git config or `gh` login, so private package
dependencies that need credentials won't resolve inside a build.

The runner's own check commands run under an equivalent macOS sandbox profile
that also blocks the keychain. SwiftPM and xcodebuild sandbox package manifests
themselves, which macOS can't nest, so inside isobot's sandboxes `swift` and
`xcodebuild` are wrapped to turn that inner sandbox off (the outer one already
confines the build).

Builders don't get your Link payment and identity skills (`create-payment-credential`,
`financial-insights`, `use-link-identity`): `builder.settings.permissions.deny` blocks
them, because builders work on issues other people wrote.

## Test devices and the isobot shell

The builder's Bash sandbox can't reach CoreSimulator or let adb bind its port, so a
builder can compile an app but not run it. The runner's check sandbox can. Two things
use that:

- **The isobot shell.** Every builder session gets an MCP tool, `mcp__isobot__shell`
  (`runner/src/mcp.ts`). It runs a command in the job's workspace under the check sandbox:
  the same limits as the runner's own checks (no keychain, credentials or runner state;
  writes only to the workspace, temp and build caches), plus simulators, adb and local
  ports. Builder-written code already runs there as checks, so the tool grants nothing
  new. It just lets the builder run device tests while it works, not only afterwards.
- **Per-job devices.** A repository with `devices` configured gets fresh devices for
  each job, booted by the runner before the builder starts and deleted when the job ends:

  ```json
  "devices": { "ios": { "deviceType": "iPhone 17" }, "android": { "avd": "isobot-api35" } }
  ```

  The iOS simulator is a new `isobot-<job>` device (`runtime` optional; newest iOS by
  default). The Android emulator boots the job's own AVD, `isobot-job-<job>-<port>`: a copy
  of the named AVD's `config.ini` (same system image and hardware) with fresh data, cold-booted
  (about 20 seconds, under 1 GB) on a port from 5600 up and deleted with the job. The named AVD
  is only a template: it's never booted or modified, so an emulator you or another agent session
  boot from it (even writable) can't block a job, and your own emulators (5554+) are never
  touched. Several jobs run side by side (`maxConcurrentJobs`, 3 by default here), each with its
  own simulator and emulator. Checks and the isobot shell see the devices as `$ISOBOT_IOS_SIMULATOR` and
  `$ANDROID_SERIAL` (adb and Gradle read the latter). The builder is told the ids and
  uses argent with exactly those devices to install, launch and screenshot UI changes.
  A device that won't boot retries the job later rather than failing the issue. At
  startup the runner deletes any `isobot-*` simulators, isobot-port emulators and
  `isobot-job-*` AVDs a crash left behind.

The `isobot-api35` AVD (Pixel 7, API 35, Google APIs, arm64) was made for the runner:

```sh
avdmanager create avd -n isobot-api35 -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7
```

`npm run runner -- checks <repo>` boots the repository's devices too, so try a new device
check there before a job depends on it.

## Screenshots and recordings

When a change is visible, the builder saves screenshots and short recordings of it to
`$ISOBOT_MEDIA`, a fresh temp folder per build that both of its sandboxes can write.
It captures from its own devices through the isobot shell (`xcrun simctl io … screenshot`
or `recordVideo`, `adb exec-out screencap`, `adb shell screenrecord`) or with argent. File
names set the order and the caption: `01-before-export-sheet.png` is shown as "Before
export sheet". Nothing visible changed, nothing captured.

The runner takes only regular PNG, JPEG, GIF, WebP, MP4 or MOV files whose bytes match
their extension: at most 8, images up to 8 MB, recordings up to 50 MB (`media.ts`). Then:

- The reviewer gets their paths and looks at them alongside the diff.
- They're committed to the repository's `isobot/media` branch (an orphan branch, one commit
  per publish under `<issue>/<time>-<sha>/`, each keeping the last as its parent, so old
  links keep working). The PR body gets a **Screenshots** section linking each file at that
  commit: images inline, recordings as links, because GitHub only embeds video it hosts
  itself. The branch has no workflows, so pushing it runs no CI. On a public repository the
  branch is public too.
- They're uploaded to the job's Discord thread, where Discord shows images and MP4s inline.
  Files over Discord's 10 MB bot limit are listed instead, pointing at the PR.

Files left out are explained in the thread. A publishing failure only costs the pictures,
never the job. Revisions capture again, so the PR body and thread show the latest state.
