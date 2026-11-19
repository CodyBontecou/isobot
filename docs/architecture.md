# isobot architecture

isobot is an always-on assistant. It watches Discord, GitHub and email, digests
what it finds, proposes work, and builds approved work through to a merged,
released change. This page is the target design; keep new work consistent with it.

```
 Sources                 Triage (runner + Claude Code)        Work queue
 Discord ─┐              summarise · dedupe · score           GitHub issues
 GitHub  ─┼─▶ inbox ──▶  "worth building?" → spec      ──▶    isobot:* labels
 Email   ─┤              never acts on message text
 Vox/you ─┘                                                        │
                                                                   ▼
 You ◀── Discord/issue updates ◀── Release ◀── Gates ◀── Build (runner, Mac)
                                   onMerge      checks    worktree per issue
                                   onShip       review    implement → check →
                                   (ship label) policy    review → revise loop
```

## Components

| Component | Where it runs | Role |
| --- | --- | --- |
| Discord bridge (`src/`, `bridge/`) | Cloudflare Container → Mac mini | Discord Gateway, GitHub webhook sync, Discord history API |
| Pi agent (`cloudflare/`) | Cloudflare Worker → Mac mini | Chat, console, iOS app, Vox captures, Discord ticket creation |
| Runner (`runner/`) | This Mac → Mac mini | Triage, build, review, merge, release ([runbook](runner.md)) |
| Build sandbox (`sandbox/`) | Cloudflare Containers | Builds for repos and sites with `executor: "cloudflare"` ([cloud builds](cloud-builds.md)) |

The runner is plain Node with local SQLite (`node:sqlite`), a launchd agent and
the `claude` CLI. It already runs on any Mac, including the mini, unchanged.

## The work queue is GitHub labels

| Label | Meaning | Set by |
| --- | --- | --- |
| `isobot:proposed` | Triage thinks this is worth doing | Runner triage, community forum posts |
| `isobot:ready` | Approved: build it | **You** (label, or ✅ on a triage digest, the issue's Discord help thread or job card), or your own `@isobot` ticket in Discord |
| `isobot:building` | Claimed by the runner (its claim comment holds the runner's lease) | Runner |
| `isobot:review` | PR open, waiting for your merge decision | Runner |
| `isobot:failed` | Couldn't finish; comment explains | Runner |
| `isobot:ship` | Approve the ship step (App Store) | **You** |
| `isobot:stop` | Hands off, at any point | **You** (label, or 🛑 in Discord) |
| `isobot:cleanup` | Dismiss: runner removes its local leftovers and labels, closes the issue as not planned | **You** (label, or 🧹 in Discord) |

Using issues as the queue means no extra infrastructure, a visible history, and
the same behaviour wherever the runner lives.

## Trust boundary

Anyone can post in Discord or email you, so their words are data, never
instructions:

1. Triage reads untrusted content with **no tools** and outputs proposals only.
   Proposals in public repositories never name or quote people.
2. Proposals never build until **you** add `isobot:ready`; the runner checks
   who added the label and ignores approvals from anyone else. A ✅ (or 🔁,
   🛑, 🧹) reaction counts only from the bridge allowlist, and the bridge adds the label with
   your GitHub token, so the same check applies. Only tickets you
   create yourself (the owner-only `@isobot` mention) start as ready.
3. For a proposal, builders get isobot's own vetted spec, not the reporter's
   text. Issues by anyone other than you (or `trustedAuthors`) can be built but
   never merge without you, and an issue edited mid-build loses auto-merge.
4. Builders work in a throwaway clone with a scrubbed environment: no GitHub,
   Pi, email or API credentials, no global git config (credential helpers), no
   `gh` login. Shell commands run in Claude Code's sandbox, which can write only
   to the workspace and toolchain caches and can't read credential folders or
   runner state. The runner copies the builder's commit into its own clone,
   diffs and judges it there, and pushes that exact commit with git hooks off.
   The runner's own checks (`npm test`, `xcodebuild test`…) execute
   builder-written code, so they run under a macOS sandbox profile with the
   same limits plus no keychain access. Changes to CI workflows are never
   pushed, because a pushed branch's workflows run with repository secrets.
5. Merge decisions are deterministic code (`runner/src/policy.ts`), not the
   model's opinion, and are re-checked right before merging. Policy lives in this
   repo, and agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.claude/`) are
   protected paths, so a builder can't grant itself more autonomy.

The sandbox and permission rules are defence in depth on a personal account. On
the mini, run the runner as a dedicated macOS user that holds no personal
credentials; that is the real isolation boundary.

## Autonomy and gates

Per repository in `runner/config/isobot.json`:

- `off`: ignore. `pr`: build and open a PR; you merge. `merge`: merge
  automatically when every gate passes.
- Gates for an automatic merge: configured runner checks pass; the independent
  reviewer approves with confidence ≥ `minReviewConfidence` and not high risk;
  no protected paths (auth, sign-in,
  credentials, purchases, paywalls, entitlements, Info.plist, CI, migrations…,
  matched as folders and as file names); no net deletion of test lines and no
  new skip/ignore/focus markers (`it.skip`, `XCTSkip`, `-skip-testing`,
  `@Ignore`…) in any file; no stop label; issue unchanged and written by a trusted author; GitHub CI green
  when `requireCi` (a PR with no CI at all counts as not green, so set
  `requireCi: false` for repos without CI).
- `merge` is rejected by the config loader unless the repo has check commands.
- Release: `release.onMerge` commands run on the merge commit after any isobot
  merge (deploy a Worker, upload to TestFlight). `release.onShip` (App Store
  submission) runs only after you add `isobot:ship`.

Start every repository at `pr`. Promote one to `merge` once its checks are
trustworthy and a run of isobot PRs needed no changes from you.

## Path to full autonomy

Each step widens what merges without you, so take them in order:

1. Gates you can trust: every merge repo has runner checks that exercise
   behaviour, not just a build, and this repo's own CI (`.github/workflows/ci.yml`)
   guards the policy code.
2. Someone notices when isobot stops: set `ISOBOT_HEARTBEAT_URL` (runner.md).
3. The real isolation boundary: run the runner as the dedicated `isobot` user on
   the Mac mini (below), not your personal account.
4. Promote repositories one at a time: `ownerAutonomy: "merge"`, then `autonomy:
   "merge"` once a run of isobot PRs needed nothing from you. Repos without
   tests (Instarep.ly) or runner checks (time.md) stay at `pr` until they have them.
5. Last: `release.onShip` without the ship label. Keep the App Store step manual
   until the release train has shipped cleanly for a while.

## Models

Builders, reviewers and triage use Claude Code with your claude.ai subscription
(`claude -p`); `ANTHROPIC_API_KEY` is stripped from their environment so usage
never falls back to API billing. Each call counts toward your plan's usage
limits, which is why `maxConcurrentJobs` and the fix/review round limits exist.
Pi keeps its Workers AI / ChatGPT models for chat. The `Builder` interface in
`runner/src/builder.ts` is the seam for adding a Pi-based builder later.

## Moving to the Mac mini

1. Create a standard macOS user `isobot` with auto-login, Xcode, Node 22+,
   Claude Code (`claude setup-token` for an unattended token) and git.
2. Clone this repo, copy `runner/runner.env.example` to
   `~/Library/Application Support/isobot/runner.env`, run
   `runner/launchd/install.sh`, then `node runner/dist/main.js doctor`.
3. Bridge: run the existing Docker image (or plain Node) under launchd, and
   point `isobot.isolated.tech` at it with a Cloudflare Tunnel; no ports open.
4. Pi: replace the Cloudflare-specific layer. pi-durable already ships Node
   storage (`storage/sqlite/node`) and execution (`env/node`); swap Durable
   Objects for SQLite files, Workers AI for an API or local model, Cloudflare
   cron for launchd, and Wrangler secrets for the runner's env file. Serve
   `pi.isolated.tech` through the same tunnel.
5. Give each runner its own `ISOBOT_RUNNER_ID` (say `laptop` and `mini`). Claim leases
   keep them from building the same issue while both run during the move
   ([runner.md](runner.md#two-runners)). Each runner's `runner.sqlite` holds only its own
   jobs, so let the old runner finish its jobs before you switch it off.
6. Sizing (32 GB / 2 TB): keep `maxConcurrentJobs` at 2 while builds use Xcode;
   worktrees and DerivedData live on the internal SSD. Local models up to
   ~30B parameters are fine for triage and summaries, not for unattended code.
