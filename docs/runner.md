# isobot runner

The runner is isobot's always-on worker. It claims approved GitHub issues,
builds them with Claude Code in isolated git worktrees, verifies and reviews the
result, opens a PR, merges when policy allows, runs release steps, and triages
new Discord, GitHub and email activity into proposals. Design:
[architecture.md](architecture.md).

## What happens to an issue

1. You add `isobot:ready` (or create a ticket with `@isobot` in Discord).
2. Within a minute the runner swaps it to `isobot:building` and comments.
3. A Claude Code builder implements it on `isobot/<number>-<slug>` in a fresh
   worktree and commits.
4. The runner runs the repo's `checks`. Failures go back to the builder
   (up to `maxFixRounds`).
5. A separate read-only Claude Code reviewer judges the diff. Change requests go
   back to the builder (up to `maxReviewRounds`).
6. The runner pushes and opens a PR with the summary, check results and review.
7. If every gate passes and the repo's autonomy is `merge`, it waits for GitHub
   CI and squash-merges. Otherwise it labels `isobot:review` and explains why.
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
| `status` | Recent jobs and their states |
| `pause` / `resume` | Stop or restart claiming new work |
| `once` | Build whatever is approved right now, then exit |
| `triage` | One triage pass, printed as JSON |
| `doctor` | Configuration and connectivity checks |

Logs: `~/Library/Application Support/isobot/logs/runner.log`. State:
`runner.sqlite` beside it. Worktrees are removed after each job; clones in
`repos/` are reused.

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
