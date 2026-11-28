# Security audit

With `"security": {}` in the runner config, the runner audits every repository it builds once a night, between
`hours` (default 1:00–7:00 local), one repository per look, and turns what it finds into fixes.

| Source | What it gives | Needs |
| --- | --- | --- |
| osv-scanner (`osv-scanner scan source -r`) | Known advisories in every lockfile: npm, Cargo, RubyGems, Go, PyPI, SwiftPM… with the versions that fix them. Vendored and fixture lockfiles are skipped | `brew install osv-scanner` |
| GitHub secret scanning | Open alerts for credentials GitHub found in the repository or its history (the secret itself is never read) | Secret scanning on (it is by default on public repositories); the runner's `repo` token |
| gitleaks (`gitleaks dir --redact`) | Hardcoded-secret hits in the tree, redacted. Its `generic-api-key` rule fires on hashes and sample data, so those count only in source and config files outside tests and docs | `brew install gitleaks` |
| A read-only agent review (Read, Grep, Glob) | Real, exploitable problems: secrets in code, server endpoints and webhooks without auth or signature checks, injection, SSRF, path traversal, CORS, tokens outside the Keychain/Keystore, TLS turned off, exported Android components and deep links, WebView bridges, CI workflows that run untrusted input | The builder's Claude login |

The agent reviews the **whole repository** once every `fullEveryDays` (default 7). Only one full review runs a
night, so the repositories take turns. On other nights it reviews the **commits since the last audit**, and it
skips a night with no new commits unless GitHub has a secret alert it hasn't looked at. The scanners run every night.

## What it does with them

- **Dependencies.** One issue per lockfile with an advisory at or above `dependencySeverity` (default high), with a
  table of packages, advisories (linked to osv.dev) and the "fixed in" versions. Advisories are already public, so
  the issue has the full details. While that issue is open, the lockfile gets no new one. A closed issue gets a new
  one only for advisories it didn't list.
- **Code findings.** Each finding at or above `minSeverity` (default medium) with confidence at or above
  `minConfidence` (default 0.7) becomes one issue. A finding is the same as an earlier one when it has the same
  category and first file, and it isn't filed twice. The agent also sees the open security issues and the findings
  filed before, so it doesn't report them again.
- **Public repositories.** An issue that describes an unfixed hole is a disclosure. On a public repository the
  issue is titled `Security hardening: <component>` and gives only the severity and the files. The details (what's
  wrong, how it's exploited, the fix) are stored on the runner. pipeline.ts appends them to the build task, with
  rules that keep commits, the PR summary and the review neutral. `node dist/main.js security show <id>` prints
  them. Private repositories get the details on the issue.
- **Approval.** With `autoApprove: true` (isobot's config has it on), issues are opened `isobot:ready` +
  `isobot:auto` + `security`, so isobot builds, reviews, merges and ships the fix under the repository's
  `ownerAutonomy`. Fixes that touch protected paths (auth, payments, entitlements, CI, `.env`) still wait for
  your review, like any build. `isobot:stop` on an issue cancels it. Without `autoApprove` they're
  `isobot:proposed`. At most `issuesPerPass` (default 3) per repository a night, most severe first; the rest
  follow on later nights.
- **What only you can do.** A leaked credential has to be revoked and rotated wherever it was issued. Removing it
  from the code doesn't make it safe, and isobot never rewrites git history. Every open GitHub secret alert, and
  every finding with an `ownerAction`, is a 🔑 flag in the daily check-in until the alert is closed.
- **Builds.** The builder first confirms the finding is real. If it isn't, it makes no change and says why, and
  the issue closes as already done. A fix comes with a regression test where the code can be tested.
  A secret moves to configuration, and the code fails clearly without it.
- **Check-in.** A **Security** section has a line per repository with findings or vulnerable lockfiles. These
  flags post a check-in on their own: a key to rotate, a critical finding filed today, a repository not audited
  for 3 days, or a scanner that failed.
- **Board.** Issues carry `<!-- isobot:security:… -->` and show as **Security audit**.

## Settings

```json
"security": {
  "autoApprove": true, "issuesPerPass": 3, "fileIssues": true,
  "minSeverity": "medium", "minConfidence": 0.7, "dependencySeverity": "high",
  "fullEveryDays": 7, "hours": [1, 7],
  "repos": ["codybontecou/health-md"], "osvScanner": "osv-scanner", "gitleaks": "gitleaks"
}
```

`repos` defaults to every configured repository isobot builds. `fileIssues: false` keeps the check-in section but
never opens issues.

## By hand

```sh
node dist/main.js security                       # print the check-in's security section
node dist/main.js security sync                  # audit the next repository not audited today, now
node dist/main.js security sync owner/repo       # audit that repository now
node dist/main.js security show <id>             # a public issue's private details (the id is in its marker)
```
