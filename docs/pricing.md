# Pricing train

isobot sets the prices of each app's in-app purchases and subscriptions on the App Store and Google Play, to earn the
most per new user. It changes prices on its own within bounds the config sets, measures each change against the
period before it, and undoes a change that clearly lost money. Code: `runner/src/pricing.ts`.

Only prices move. Which products exist, trials, offers and the paywall stay the owner's.

## How it works

1. **Snapshot (every 6 hours).** Each product's live US price in USD: App Store subscriptions and non-consumable
   in-app purchases that are on sale (`asc … pricing summary`), and Play's active base plans and one-time purchase
   options. The first snapshot is the baseline. The price isobot first sees is each product's **anchor**, and the
   bounds are relative to it. A price someone changes by hand (App Store Connect, Play Console) is recorded as an
   outside change and posted, so no measurement window ever straddles one.
2. **Measure.** The measure is **value per first download**: lifetime proceeds, plus each new paid subscription's
   first payment × the paid periods a subscriber is expected to stay (`expectedPeriods`, default week 8, month 5,
   year 1.5), after the store's fee (`fee`, 15%). A free trial's conversion counts on the day the trial started,
   because that day's price is what it converts at. The App Store side uses Apple's Sales and Trends and subscription
   event reports ([analytics](analytics.md#sales-and-trends-history)); the Play side uses Play Console's reports
   (installs from the listing, one-time orders' share of net proceeds, new subscriptions per product).
3. **Evaluate.** Once a change has been live `minDays` (28), and its window has had `minDownloads` (150) first downloads
   or reached `maxDays` (56), it is compared with the window of the same length before it, but never earlier than the
   previous change. The staff channel gets both windows, the change in value per download, and how often a bootstrap
   over days finds the new price worse. **Better** means more per download in ≥80% of resamples; **worse** means less
   in ≥80%; anything else is unclear. A change that is worse and earns under `revertBelow` (85%) of the old value per
   download is undone on its own.
4. **Decide (every `everyDays`, once the current prices have been live `minDays`).** A Claude run reads the products
   with their bounds, 12 weeks of numbers, every earlier change with its reason and outcome, the last 28 days of
   subscription events, and the app's repository (read-only, to see how the paywall shows prices). It either holds
   or moves up to three prices of the app at once. The runner checks every guard itself and rejects a decision that
   breaks one. A hold is posted as one line.
5. **Apply.** The post lists each price before and after and carries 🛑.
   - App Store subscriptions get Apple's equalized prices for every territory from the US price
     (`asc subscriptions pricing equalize`), from the next day. An increase keeps existing subscribers on their price
     (`--preserved`), so nobody gets a consent email. A decrease reaches existing subscribers too.
   - App Store in-app purchases get a new US base price from the next day; Apple equalizes the other territories.
   - Play base plans and one-time products get Google's converted regional prices (`pricing:convertRegionPrices`).
     Existing subscribers keep their legacy price. The write is read back, and one that didn't take fails.
   - With `siteIssues`, the app's repo gets an issue (`isobot:ready` + `isobot:auto`) to update prices the marketing
     site, docs and fallbacks hardcode. It lists the prices only; the reasoning stays in the staff channel.

Each app (App Store and Play apart) has one change in flight at a time: a change is judged before the next one, so
every change gets a clean window. With a few purchases a day, that means a change every 4–8 weeks per app at most.

## Guards

Enforced by the runner, whatever the decision says:

- **Bounds:** `floor`–`ceiling` (0.5×–2×) of the anchor, narrowed by the repo's `bounds` per product id.
- **Step:** at most `maxStep` (35%) from the current price per change, and at most three products at once.
- **Locked:** upgrade products (their price is a difference between two others) and the repo's `lock`.
- **The paywall still makes sense:** a yearly plan costs under 90% of 52 weeks or 12 months of the same tier (the
  "Best value" label and the computed savings stay true), lifetime costs more than yearly, family costs at least
  individual, and where a family upgrade exists, family lifetime minus individual lifetime stays the upgrade's price
  (both lifetimes move by the same amount). Only problems a change causes count; ones the live prices already have
  don't block it.
- **Price points:** App Store prices are checked against Apple's price points before anything is written (a dry run
  for subscriptions, the price point list for in-app purchases).

## Stopping it

- **🛑** on a change's post (by someone on the staff chat's allowlist) undoes it: each product goes back to its earlier price.
- `pricing pause` stops all decisions; outcomes and 🛑 still run. `pricing resume` restarts them.
- A repo's `pricing.autonomy`: `off`, `report` (snapshots and outcomes only), `propose` (each decision is posted with ✅
  and 🛑; ✅ applies it, unanswered ones expire after 7 days) or `apply` (all four apps).

## Configuration

```jsonc
// runner/config/isobot.json
"pricing": {},   // runner-wide; every field optional:
// minDays 28, maxDays 56, everyDays 7, minDownloads 150, maxStep 0.35, floor 0.5, ceiling 2,
// revertBelow 0.85, hours [9, 21], trialDays 7, fee 0.15, expectedPeriods { week: 8, month: 5, year: 1.5 }
"repos": {
  "codybontecou/GitSync.md": {
    "aso": { "appId": "6758960270", "play": { "packageName": "com.bontecou.syncmd" } },
    "pricing": { "autonomy": "apply", "siteIssues": true }
  }
}
```

Per repo: `autonomy`, `appId` / `packageName` (default the `aso` ones), `play: false` to leave Play alone, `lock`
(product ids or names), `bounds` (`{ "<productId>": { "min": 1.99, "max": 4.99 } }`), `siteIssues` and `notes`
(read by the decision run). The isobot repository is public, so pricing reasoning never goes in its config: put it in
`notes` only if it's fine to publish.

App Store writes use the runner's `asc` key (Admin). Play writes use the `aso.googleKey` service account, which needs
Play Console's "Manage store presence" permission (in-app products and subscriptions).

## Commands

```sh
npm run runner -- pricing                         # every app: prices, bounds, recent changes, when it decides next
npm run runner -- pricing health-md snapshot      # read the stores now
npm run runner -- pricing health-md decide --dry-run   # run a decision now; print it and the numbers it saw, change nothing
npm run runner -- pricing com.healthmd.android decide  # decide (and apply) now for the Play app
npm run runner -- pricing health-md revert        # undo the newest isobot change
npm run runner -- pricing pause | resume
```

State in `runner.sqlite` cursors: `pricing:<appId>:products` (price, since, anchor), `…:history` (every change with
its reason, outcome and undo), `…:pending`, `…:decided`, `…:since` (first snapshot) and `pricing:paused`. Events:
`pricing_applied`, `pricing_reverted`, `pricing_outcome`, `pricing_hold`, `pricing_decided`, `pricing_outside`,
`pricing_error`.

## Limits

- The numbers are small (around 10 first downloads and a few purchases a day per app), so most decisions will be holds,
  and an outcome is often unclear. The bootstrap is over days, so a single big lifetime sale moves it less than it
  would a plain average.
- `expectedPeriods` is a guess until subscriptions are a few months old; each decision run checks it against the
  renewals and cancellations it sees and says when it looks wrong. Raise or lower it in the config.
- Weeks before isobot's first snapshot value new subscriptions at today's prices, since the runner doesn't know earlier
  prices (lifetime proceeds are what was paid).
- Prices are set from the US price. Regional pricing beyond Apple's and Google's equalization isn't tuned.
- A Play subscription product with several base plans (Whereday) reports new subscriptions per product, not per plan,
  so the first base plan's price stands in for all of them.
