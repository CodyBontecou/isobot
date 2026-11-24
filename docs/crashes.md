# Crash audit

With `"crashes": {}` in the runner config, the runner reads what crashes in isobot's apps every 6 hours,
straight from the stores (no crash SDK in the apps), and turns new crashes into proposals.

| Source | What it gives | Credentials |
| --- | --- | --- |
| Google Play (Play Developer Reporting API) | Error issues, Play's own clusters of crashes and ANRs, with a sample stack trace each; daily crash and ANR rates (Play returns rates only above its privacy threshold, so small apps often have none) | The ASO train's service account (`aso.googleKey`); it needs "View app information" on the Play apps |
| App Store (Analytics Reports, "App Crashes") | Crash counts and devices by app version. Apple writes the report daily, weekly or monthly depending on volume; there are no stacks (those are in Xcode Organizer) | The asc CLI, read-only, and the same ONGOING report request [App Store analytics](analytics.md) reads |
| TestFlight (`betaFeedbackCrashSubmissions`) | Testers' crash submissions, each with its crash log | The asc CLI, read-only |

Play apps are the repos with `aso.play`; App Store apps are `appStore.apps`.

## What it does with them

- **Groups.** Play splits one bug into several issues (per version, per slightly different frame). The audit
  groups them: ANRs by the frame they block in, out-of-memory crashes by class (the frame is only where the last
  allocation failed), obfuscated frames into one pool, everything else by frame and exception.
- **Issues.** Each group with at least `minUsers` affected users (default 2) becomes one GitHub issue in the app's
  repo, labelled `bug`, with the reports, users, version codes, a shortened sample stack and
  links to Play Console. At most `issuesPerPass` (default 3) per app and pass, biggest first; the rest follow on
  later passes. An open issue that already names the crashing method counts as filed. Each TestFlight crash
  signature (the first app frame of the crashed thread) is one issue too; the first pass files only the last
  7 days' submissions. Obfuscated groups are never filed: upload the R8 mapping file to Play to make them readable.
  With `autoApprove: true` (isobot's config has it on) each issue is opened approved (`isobot:ready` +
  `isobot:auto`, as triage does for small work), so isobot builds, reviews, merges and ships the fix under the
  repo's `ownerAutonomy` without waiting; the staff channel gets a 💥 message listing them, and `isobot:stop`
  on an issue cancels it. Without it, issues are `isobot:proposed` and wait: the staff channel gets a 💥 summary
  and one 🗳 message per issue with ✅ (build it) and 🧹 (dismiss) reactions, or add `isobot:ready` on GitHub.
  Triage's `autoApprove` doesn't apply to crash issues; only `crashes.autoApprove` does.
- **Check-in.** The daily check-in gets a **Crashes** section: per app, the last 7 days on Play (reports, users,
  ANRs, the top group) and Apple's latest App Crashes period. A flag posts a check-in on its own: reports doubling
  week over week, a new crash group only in the newest version code (what the last release brought), a 28-day
  user-perceived crash or ANR rate above Play's bad-behavior thresholds (1.09% and 0.47%), an App Store crash
  spike, or a source the audit couldn't read.
- **Board.** Issues it opens carry `<!-- isobot:crash:… -->` and show as **Crash report** on the board.

During a phased release (7 days, see the weekly App Store release in [runner](runner.md#weekly-app-store-release)), the "new crash group in the newest version" flag is the
signal to pause the rollout.

## Privacy

Tester emails and names are never requested. A tester's note goes into the issue only when the repo is private;
crash log excerpts keep the exception and the crashed thread, not device identifiers. Play stack traces carry no
user data.

## Settings

```json
"crashes": { "minUsers": 2, "issuesPerPass": 3, "fileIssues": true, "autoApprove": false }
```

`fileIssues: false` keeps the check-in and Discord lines but never opens issues.

## By hand

```sh
node dist/main.js crashes          # print the check-in's crash section from what's stored
node dist/main.js crashes sync     # read the stores now (opens issues for new groups), then print it
```
