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
a comment; edit the issue and add `isobot:ready` again to retry.

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

**Talking back.** Reply in a job's thread. The bridge relays replies from allowlisted users
(`ISOBOT_ALLOWED_USERS`, or the bot's owner) to the job's GitHub issue and reacts 📨. The runner
treats your comments on the issue as **notes**, wherever they came from: the thread, the issue
itself, or `npm run runner -- say time.md#12 "use the system font"`.

- **While it builds**, a note goes to the builder (same Claude session) before the next check or
  review round, at most five per build. The task the reviewer sees includes your notes.
- **On an open PR**, a note queues a revision: the runner checks out the PR branch, resumes the
  builder's session with your note, re-runs checks and review, and updates the same PR. If the
  repo merges automatically, a note that hasn't been applied yet blocks the merge.
- **After it's merged, closed or failed**, the thread says how to continue: add `isobot:ready`
  to build again (your notes go with it), or open a new issue.

Only comments written by your account (or `trustedAuthors`) count. The runner's own comments,
triage proposals and relays of community `#help` threads never do. The bridge posts with its
`GITHUB_TOKEN`, so that token must belong to you (or a `trustedAuthors` account); otherwise the
thread says the reply was ignored. Set `ISOBOT_RUNNER_CHANNEL_ID` on the bridge to only relay
from that channel.

## When things go wrong

- **Temporary problems** (network, GitHub outages, Claude overload) put the
  issue back in the queue with backoff (5 min, 15 min, 45 min, 2 h) and one
  comment; after five attempts it's marked `isobot:failed`.
- **Claude usage limit**: all builds pause until the limit resets (or an hour),
  without using up attempts. `status` shows the pause.
- **Claude Code signed out**: treated as temporary; `doctor` says so.
- **Crash or reboot**: launchd restarts the runner; interrupted builds start
  again from a clean workspace.
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
