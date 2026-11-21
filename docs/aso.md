# ASO train

The ASO train follows each app's App Store search placement and proposes listing changes. It runs in the
[runner](runner.md) on the Mac, next to [ASO Tracker](https://github.com/CodyBontecou/aso-tracker), a local
app that measures App Store search. Code: `runner/src/aso.ts`.

1. **Measure (daily, ASO Tracker).** Each app in the tracker has `autoCheck: daily`, so the tracker checks every
   tracked phrase once a day, spacing out its requests to Apple. Each hour the runner reads each app's board and
   copies newly checked ranks into its own daily snapshot (`aso:<appId>:day:<date>` in `runner.sqlite`, kept 120 days).
2. **Report (weekly).** On `reportWeekday` the staff channel gets each app's report: how many phrases rank, how many
   are in the top 10 and top 50, the biggest gains and losses (weighted by demand) against the snapshot from a week
   earlier, and listing phrases that rank nowhere. The first report is a baseline. With [App Store
   analytics](analytics.md) on, it also carries the app's last 7 days from Apple (impressions, product page views,
   page → download conversion, new downloads, proceeds, the first-run paywall's trial and paid rates, paid
   subscriptions) against the 7 before, and research
   gets the same line, so a listing change is judged by conversion as well as by rank.
3. **Propose (every `researchEveryDays`).** After that week's report, a Claude run gets the app's current listing
   (refreshed from App Store Connect), its 150 highest-demand measured phrases, its previous proposal and a
   read-only checkout of the app. It drafts a name, subtitle, keyword field and promotional text, and lists new
   phrases worth measuring. The runner then measures the new phrases (`keywords_import`) and the draft itself
   (`audit.option.add`) through the tracker, and posts the exact diff with those measurements to the staff channel.

4. **Apply.** With `autonomy: "apply"` (all four apps), isobot applies its own proposals; with `propose`, an owner's ✅
   does. See [Applying a proposal](#applying-a-proposal).
5. **Learn.** Each applied change is kept (`aso:<appId>:history`). Once its version is live, the next research run
   sees how ranks moved since, so it keeps what worked and undoes what lost ground.

Only a proposal (applied on its own, or approved) writes to App Store Connect. Listing text, and the keyword field above all, is private
strategy, so it goes only to the private staff channel, never into GitHub issues: the app repositories are public.

## Applying a proposal

With `autonomy: "apply"`, a proposal is applied as soon as it's measured, exactly as a ✅ would apply it, and the
staff channel gets the diff and what was written, for the record. A new weekly proposal replaces one whose fields
haven't gone live yet. Guards that hold either way: the brand stays at the start of the name, Apple's limits are
kept, every claim is checked against the app's code, and no other company's name is added to the name, subtitle or
keyword field (ones the live listing already has are kept).

With `propose`, a proposal's last message carries ✅ and 🛑. Every 5 minutes the runner reads them; only people on the staff chat's
allowlist (`ISOBOT_CHAT_USERS`) count.

- **✅** writes the promotional text to the live version at once (and to an editable version, if one exists), because
  it changes without review. The name, subtitle and keyword field need a new version: they wait until an App Store
  version is in Prepare for Submission (or rejected), then go onto that version's en-US localization and the
  editable app info, and go live with it. The staff channel hears what was written, and where.
- **🛑** dismisses the proposal. One nobody answers expires after 14 days. A new proposal replaces an unanswered one.
- While an approved proposal waits for a version, no new research runs, so nothing is drafted over it.
- The release trains ship to TestFlight, so they never open an App Store version. Whoever prepares an App Store
  release can run `aso <repo> apply` right after creating the version instead of waiting for the next poll, which
  matters when the version is created and submitted in one step.
- A failed write is posted once and retried on every poll. Writes go through the runner's `asc` (its App Store
  Connect key), never through ASO Tracker, whose key can't write.

Proposals also warn when the keyword field has another company's name (Apple, Obsidian, GitHub…): App Review can
reject that under guideline 2.3.7.

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
`autonomy`: `off`, `report` (snapshot and report only), `propose` (default; applied on an owner's ✅) or `apply`
(applied without asking), and `platform` (`IOS`, the default,
or `MAC_OS`) for where an approved proposal is written. Proposals always keep the brand at
the start of the name. A field over Apple's limit falls back to the current text.

The tracker's background process runs under launchd (`~/Library/LaunchAgents/tech.isolated.aso-tracker.plist`,
log `~/Library/Logs/aso-tracker.log`), so daily checks continue after a reboot. The CLI starts the process itself
if it isn't running.

## Commands

```sh
npm run runner -- aso GitSync.md snapshot            # read the board into today's snapshot
npm run runner -- aso GitSync.md report              # post the weekly report now
npm run runner -- aso GitSync.md research --dry-run  # draft and measure a proposal; print it, post nothing
npm run runner -- aso GitSync.md pending             # the latest proposal and how far it got
npm run runner -- aso GitSync.md approve             # same as ✅ (also takes a proposal posted before ✅ existed)
npm run runner -- aso GitSync.md reject              # same as 🛑
npm run runner -- aso GitSync.md apply               # write an approved proposal now, e.g. right after creating a version
```

## Google Play

A repo's `aso.play` adds its Play app to the train as a second app, named by its package (`aso md.vox.android …`).
It goes through the same steps, with Play's differences:

- **Ranks**: ASO Tracker checks Play's web search daily (its Play support, aso-tracker#1). Play shows at most about
  30 apps per search, so a dash means "not among them", and Play publishes no demand estimate. The weekly report
  gets a separate Google Play section per app.
- **Phrases**: the first research finds no tracked Play phrases and seeds up to 40 from the App Store app's phrases
  with the most demand (same storefront, the listing's script only), measures them on Play, then drafts. Each run's
  `newPhrases` (up to 40) are added the same way. The App Store's demand for a phrase is shown as a hint.
- **Proposal**: title (30 characters), short description (80) and full description (4000) for one language
  (`language`, default `en-US`). Play has no keyword field. A field falls back to the live text when it's over the
  limit, drops the brand, adds another company's name (title and short description), uses words Play's metadata
  policy forbids there (#1, best, top, free, sale, calls to action, emoji, all caps), or repeats a word enough to read
  as keyword stuffing.
- **Apply**: an Android Publisher edit that patches only the changed fields and commits. It goes to Google's review
  and is live once approved (usually hours); no release is needed. A field changed in Play Console since the draft
  is left alone. Under managed publishing the commit is saved with `changesNotSentForReview` and the staff channel
  is told to send it from Publishing overview. A failed commit (e.g. while a release is in review) is posted once and
  retried every few minutes. Applied changes go into `aso:<package>:history`, and the next research sees their
  rank movement and Play Console numbers.
- **Credentials**: a Google service account (`aso.googleKey`, default `~/.config/isobot/play-isobot-aso.json`)
  invited in Play Console with store presence, app information and bulk
  reports, financial data, release and review-reply permissions. The key file never goes into a repo or a sandbox.

```jsonc
"aso": { …, "googleKey": "~/.config/isobot/play-isobot-aso.json", "playReportsBucket": "pubsite_prod_8478281120215349264" },
"repos": { "codybontecou/vox.md": { "aso": { "appId": "6758967337", "play": { "packageName": "md.vox.android" } } } }
```

`play` takes `packageName`, `language`, `notes` (default: the App Store notes) and `autonomy` (default: the App
Store's).

## Store numbers in research

Each applied change in the research prompt carries its before/after store numbers: daily installs, page visits,
conversion and paid conversions over up to 28 days either side of the day it went live (App Store analytics, see
[analytics](analytics.md), or Play Console's reports). Fewer than 14 days after it, or fewer than 30 installs a side,
is labeled inconclusive.

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
