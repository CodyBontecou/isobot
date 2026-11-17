# isobot runner

The runner is isobot's always-on worker. It claims approved GitHub issues,
builds them with Claude Code in isolated git worktrees, verifies and reviews the
result, opens a PR, merges when policy allows, runs release steps, and triages
new Discord, GitHub, email and App Store review activity into proposals. Design:
[architecture.md](architecture.md).

## What happens to an issue

1. You add `isobot:ready` (or create a ticket with `@isobot` in Discord).
2. Within a minute the runner swaps it to `isobot:building` and comments.
3. A Claude Code builder implements it on `isobot/<number>-<slug>` in a throwaway
   clone and commits.
4. The runner runs the repo's `checks`. Failures go back to the builder
   (up to `maxFixRounds`).
5. A separate read-only Claude Code reviewer judges the diff. Change requests go
   back to the builder (up to `maxReviewRounds`).
6. The runner pushes and opens a PR with the summary, check results and review.
7. If every gate passes and the repo's autonomy is `merge`, it waits for GitHub
   CI, re-checks the gates, and squash-merges exactly the reviewed commit.
   Otherwise it labels `isobot:review` and explains why.
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

**Talking back.** Reply in a job's thread. The bridge relays replies from allowlisted users
(`ISOBOT_ALLOWED_USERS`, or the bot's owner) to the job's GitHub issue and reacts 📨. The runner
treats your comments on the issue as **notes**, wherever they came from: the thread, the issue
itself, or `npm run runner -- say time.md#12 "use the system font"`.

- **While it builds**, a note goes to the builder (same Claude session) before the next check or
  review round, at most five per build. The task the reviewer sees includes your notes.
- **On an open PR**, a note queues a revision: the runner checks out the PR branch, resumes the
  builder's session with your note, re-runs checks and review, and updates the same PR. If the
  repo merges automatically, a note that hasn't been applied yet blocks the merge.
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
remembers the conversation. Reply to a job card while mentioning isobot to ask about that job.
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

- **Daily check-in:** at `chat.checkInHour` (local time; 9 by default, `null` for none) the
  channel gets a summary of what needs you: PRs to review, jobs ready to ship, failures this week,
  proposals awaiting approval. Nothing is posted on a day with nothing to say.

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

## When things go wrong

- **Temporary problems** (network, GitHub outages, Claude overload) put the
  issue back in the queue with backoff (5 min, 15 min, 45 min, 2 h) and one
  comment; after five attempts it's marked `isobot:failed`.
- **Claude usage limit**: all builds pause until the limit resets (or an hour),
  without using up attempts. `status` shows the pause.
- **Claude Code signed out**: treated as temporary; `doctor` says so.
- **Crash or reboot**: launchd restarts the runner; interrupted builds start
  again from a clean workspace.
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
  "maxChangedLines": 300,
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

## End to end for your own work

A repository can give your own work more autonomy than community reports with
`ownerAutonomy`:

```json
"codybontecou/vox.md": { "autonomy": "pr", "ownerAutonomy": "merge", "checks": ["./scripts/test-project-contracts.sh"] }
```

Work counts as yours when the issue has `isobot:auto` **added by your account**.
The runner adds it to proposals it auto-approves from your Vox.md notes. Add it
yourself to an issue you write. A collaborator or bot adding it changes nothing,
and removing it at any point (or adding `isobot:stop`) drops back to `autonomy`.
Every merge gate still applies: runner checks, the reviewer, GitHub CI, the line
limit, protected paths and unchanged issue text. `ownerAutonomy: "merge"` needs
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
checks, the reviewer, protected paths, the line limit, CI, and an unchanged issue.

## Release train

A repo with `train` in its policy ships merged isobot work to the App Store:

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
