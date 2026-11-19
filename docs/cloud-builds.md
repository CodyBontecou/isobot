# Cloud builds

A repository or content site with `"executor": "cloudflare"` builds in a Container on
Cloudflare instead of on the runner's Mac. The heavy part of a job runs there: the clone,
Claude Code, `npm ci` and the site build. The runner stays where it is and keeps every
decision: it claims the issue, reads the builder's commits back, diffs them, runs the gates,
pushes and merges exactly as for a local build.

This is the first step of moving isobot off the Mac. It suits work that only needs Linux, such
as the content train's site builds. App builds that need Xcode, simulators or emulators stay
local.

```
 runner (Mac)                                  isobot-sandbox Worker (Cloudflare)
 claim · gates · push · merge                  one Durable Object + Container per job
   │  start, run command, read/write file  ──▶  /workspace/<job>: clone, claude -p, checks
   │  ◀── git bundle of the builder's commits        │
   ▼                                                  ▼  outbound HTTP (all of it) goes through
 bare clone: diff, ahead, push                     the Worker, which adds credentials
```

## What changes for a cloud job

- **No devices.** The Container is Linux, so `devices` are skipped. Content builds fall back
  to tracing a walkthrough through the source instead of running it on a simulator (the
  content rules already say so). This is also where most of a content job's RAM went on the Mac.
- **No screenshots or recordings.** The builder can't write to the Mac's `$ISOBOT_MEDIA`.
- **Checks run in the Container.** They have to work on Linux with Node 26, Python 3 and git.
  All the content sites' checks do.
- **The builder can't push.** git reads the job's own repository through the Worker, which adds
  a read token for that repository only and refuses `git-receive-pack`. The runner pushes the
  commit it reviewed, as before.
- **No credentials in the Container.** Claude Code starts with a placeholder token, and the
  Worker replaces it on requests to `api.anthropic.com`. Every other host gets no credentials.
  Plain HTTP is refused. The builder has the rest of the internet over HTTPS, as a local build
  does, so content can be checked against primary sources.
- **Restarts.** The Container keeps running when the Mac or runner restarts. On the next start,
  the runner stops what was running there, commits what the builder left, and resumes the same
  Claude Code session in the same Container. If the Container is gone (idle 30 minutes or
  evicted), the job starts over from the commit the runner kept, which is uploaded as a bundle.

## Turn it on for a site

```json
"codybontecou/health-md": {
  "content": { "executor": "cloudflare", "...": "..." }
}
```

`executor` also works at the repository level for ordinary issues, for repositories whose
checks need no Apple tooling.

## Set up the sandbox Worker

The Worker is `sandbox/` (`isobot-sandbox`). Deploying builds its image, so Docker (or Colima)
must be running.

1. Make a long-lived Claude Code token on the Mac: `claude setup-token`.
2. Pick an API token for the runner: `openssl rand -hex 32`.
3. Use a GitHub token that can read the repositories isobot builds. A fine-grained,
   read-only token is enough, because the Worker never pushes.
4. Deploy:

   ```sh
   cd sandbox
   npm ci
   printf '{"SANDBOX_API_TOKEN":"%s","CLAUDE_CODE_OAUTH_TOKEN":"%s","GITHUB_TOKEN":"%s"}' \
     "$SANDBOX_API_TOKEN" "$CLAUDE_CODE_OAUTH_TOKEN" "$GITHUB_READ_TOKEN" > .secrets.json
   npx wrangler deploy --secrets-file .secrets.json
   rm .secrets.json
   ```

5. In `runner.env`, set `ISOBOT_SANDBOX_URL` (the Worker's workers.dev URL) and
   `ISOBOT_SANDBOX_TOKEN` (the API token).
6. Run `npm run runner -- doctor` (it checks the Worker and the token), then
   `npm run runner -- cloud-smoke health-md --checks`. That runs one real build in a sandbox:
   clone, Claude Code, the site's content checks, and the commit back into a throwaway clone.
   It never pushes.

`INSTANCE_TYPE` in `sandbox/wrangler.jsonc` sets the Container size (default `standard-2`).

## Before relying on it

- Claude Code here uses your Claude subscription's `setup-token`, as the local builder does,
  but from Cloudflare. Check that Anthropic's terms allow that for automated hosted use; if
  not, point the Worker at the API or AI Gateway instead.
- Container time costs money. Every job holds a Container for the length of its build. Watch
  the first week's usage in the Cloudflare dashboard before moving more repositories over.
