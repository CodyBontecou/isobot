# ASO train

The ASO train follows each app's App Store search placement and proposes listing changes. It runs in the
[runner](runner.md) on the Mac, next to [ASO Tracker](https://github.com/CodyBontecou/aso-tracker), a local
app that measures App Store search. Code: `runner/src/aso.ts`.

1. **Measure (daily, ASO Tracker).** Each app in the tracker has `autoCheck: daily`, so the tracker checks every
   tracked phrase once a day, spacing out its requests to Apple. Each hour the runner reads each app's board and
   copies newly checked ranks into its own daily snapshot (`aso:<appId>:day:<date>` in `runner.sqlite`, kept 120 days).
2. **Report (weekly).** On `reportWeekday` the staff channel gets each app's report: how many phrases rank, how many
   are in the top 10 and top 50, the biggest gains and losses (weighted by demand) against the snapshot from a week
   earlier, and listing phrases that rank nowhere. The first report is a baseline.
3. **Propose (every `researchEveryDays`).** After that week's report, a Claude run gets the app's current listing
   (refreshed from App Store Connect), its 150 highest-demand measured phrases, its previous proposal and a
   read-only checkout of the app. It drafts a name, subtitle, keyword field and promotional text, and lists new
   phrases worth measuring. The runner then measures the new phrases (`keywords_import`) and the draft itself
   (`audit.option.add`) through the tracker, and posts the exact diff with those measurements to the staff channel.

The ASO train never writes to App Store Connect. Listing text, and the keyword field above all, is private
strategy, so it goes only to the private staff channel, never into GitHub issues: the app repositories are public.
Name, subtitle and keyword changes take effect with the next app version; promotional text can change at any time.

## Configuration

```jsonc
// runner/config/isobot.json
"aso": {
  "cli": "~/dev/aso-tool/bin/aso.mjs",            // or an installed app's Contents/Resources/aso
  "appBinary": "~/dev/aso-tool/release/mac-arm64/ASO Tracker.app/Contents/MacOS/ASO Tracker",
  "appPath": "~/dev/aso-tool/release/mac-arm64/ASO Tracker.app/Contents/Resources/app.asar",
  "reportWeekday": 1, "researchEveryDays": 7, "hours": [8, 22]
},
"repos": { "codybontecou/GitSync.md": { "aso": { "appId": "6758960270" } } }
```

Per app: `locale` (default `en-US`), `storefront` (default `us`), `notes` (brand, tone, phrases to keep) and
`autonomy`: `off`, `report` (snapshot and report only) or `propose` (default). Proposals always keep the brand at
the start of the name. A field over Apple's limit falls back to the current text.

The tracker's background process runs under launchd (`~/Library/LaunchAgents/tech.isolated.aso-tracker.plist`,
log `~/Library/Logs/aso-tracker.log`), so daily checks continue after a reboot. The CLI starts the process itself
if it isn't running.

## Commands

```sh
npm run runner -- aso GitSync.md snapshot            # read the board into today's snapshot
npm run runner -- aso GitSync.md report              # post the weekly report now
npm run runner -- aso GitSync.md research --dry-run  # draft and measure a proposal; print it, post nothing
```

## Apple endpoints, and running on Cloudflare

Ranks come from the App Store app's own search endpoint (`search.itunes.apple.com/WebObjects/MZStore.woa/wa/search`)
and its autocomplete (`MZSearchHints`). Apple doesn't document them. The documented iTunes Search API doesn't rank
results the way the App Store does. App details use the documented iTunes lookup API, listings the public
`apps.apple.com` pages, and owned listings the App Store Connect API.

A test on 2026-11-20 ran the tracker's own Apple client, unchanged, in a Cloudflare Worker (colo MIA) on 16 tracked
phrases in the US, DE and JP, at the same time as the Mac:

- The tracker's Apple code bundles for Workers as is. Workers' `fetch` rejects `redirect: "error"`, so it needs a small
  adapter (`redirect: "manual"`, failing on 3xx).
- About 30–55% of searches from the Worker got an empty HTTP 403 from Apple, at both 1.2 s and 4 s between requests,
  while the Mac got none. It looks like Apple blocks some of Cloudflare's shared outbound IPs rather than throttling
  our request rate. Retrying after 0.5 s got all 32 phrase searches through across two runs, at about 1.5 requests
  per phrase.
- When the Worker got an answer, it matched the Mac exactly: the same top 25 apps in the same order and the same
  rank for our apps, on every phrase.

So the measurement could move to a Worker or a Durable Object, with retries and alarm-driven batches. What's
left to port is the tracker's job queue and storage (Durable Object SQLite), and App Store Connect signing (WebCrypto).
Until then the Mac runs it.
