# App Store analytics

Apple's own numbers for each App Store app, from the App Store Connect Analytics Reports API, read by the runner
(`runner/src/analytics.ts`) and used in three places:

- **Daily check-in** (staff chat): a line per app for its latest complete day: new downloads against the
  7-day average, impressions → product page views and the share that downloaded, purchases and proceeds, and
  subscriptions (paid, in trial, offer starts, conversions, churn). A flag posts a check-in on its own: new
  downloads at 2× or under 0.4× the 7-day average (when that is at least 5 a day), 3 or more churned subscriptions
  at twice the usual rate, or no new data for 5 days.
- **First-run paywall funnel** (in the check-in over the last 7 days, and in the weekly report against the week
  before): every app shows its paywall on first launch, so Apple's first-time downloads stand in for paywall
  views. Subscription apps get paywall → trial (offer starts per download) and paywall → paid (subscriptions from
  an offer, or Apple's direct `Subscribe` event, per download); apps without subscription events get paywall →
  purchase. Apple can't see the paywall itself, and a download that's never opened counts too, so the rates are a
  floor. Cohorts don't line up day by day (a trial converts a week later), so it's never shown for a single day.
- **Weekly ASO report** ([ASO train](aso.md)): the last 7 days against the 7 before, and the same line in the
  listing research prompt. A week counts only when all 7 days have arrived, so a first backfill doesn't read as a
  jump.
- **Staff chat**: the `app_analytics` tool returns an app's daily numbers (or every app's last week).

## How it reads

Each app needs an ONGOING analytics report request in App Store Connect (`asc analytics requests --app <id>`
lists them; `asc analytics request --app <id> --access-type ONGOING` creates one). All five apps had one on
2026-11-20. Apple then produces daily reports on its own; the runner only reads, through `asc` with
`ASC_READ_ONLY=1` and `asc api GET`.

Every 6 hours, for each app, the runner lists the daily instances of the seven reports it reads (App Store
Discovery and Engagement, App Downloads, Installation and Deletion, App Sessions, App Store Purchases, Subscription
Event and Subscription State, all Standard) and downloads the ones it hasn't read, newest first, at most 20 per app
and pass (about 135 requests a pass for five apps). A normal day costs about 14 requests per app. A first backfill
of `backfillDays` (35) of processing dates, about 245 instances per app, takes about 3 days of passes, so it never
crowds out releases and the ASO train on the shared API key. A 429 from App Store Connect ends the pass for every app, since the rate limit
belongs to the API key that releases and the ASO train also use, and the next pass comes 65 minutes later instead of
6 hours.

Apple restates recent days: the instance processed on day P has rows for P-1 back to P-3 (sessions: P-6). So each
day keeps, per report, the numbers from the newest processing date that covered it. The newest complete day is
usually two days ago. Apple drops rows under its privacy thresholds, so small numbers are approximate, and the
Detailed reports are often empty for small apps; the runner reads only the Standard ones.

State is in `runner.sqlite` cursors: `analytics:<appId>:day:<date>` (kept 400 days), `…:request`, `…:reports`,
`…:seen` (instance ids read) and `…:name` (the app name Apple reports).

## Sales and Trends history

The Analytics Reports above start the day a report request was made and give proceeds as one number. For revenue
history the runner also keeps Apple's **Sales and Trends** reports (`runner/src/sales.ts`). Apple serves these only for a while:
daily reports for 365 days, monthly for 12 months, yearly indefinitely. So each report is downloaded once and stored
for good in `runner.sqlite`:

- **Sales, daily** (`SALES SUMMARY`): per app (every app of the vendor, not only `appStore.apps`): first downloads,
  redownloads, lifetime unlocks, subscription charges (and renewals among them), free trial starts (subscriptions
  at a price of 0), refunds, and proceeds by kind: lifetime, subscriptions, paid downloads, other. In-app rows name
  their app by SKU, mapped through `asc apps list` (kept a week) and the app's own rows.
- **Sales, yearly**: whole years before the daily window (2025 for this account), converted at the mid-year rate.
- **Subscriptions, daily** (`SUBSCRIPTION SUMMARY` 1_4): active subscriptions by plan (paid, free trial, other
  offers, billing retry and grace) and the paid ones' monthly proceeds (weekly × 52/12, yearly ÷ 12).
- **Subscription events, daily** (`SUBSCRIPTION_EVENT SUMMARY` 1_3): free trials started, converted to paid and
  cancelled (auto-renew turned off before the first charge), paid subscriptions cancelled, renewed (by paid period:
  2 = first renewal), reactivated, refunded, in billing retry or recovered from it, and plan changes. Kept per app and
  plan, with subscribers on an older price (Apple's preserved pricing) apart, plus every event by Apple's name and
  the cancellation reasons. Apple has them from about Oct 19, 2026 for this account.

Proceeds are converted to USD at the ECB's reference rate for that day, from Frankfurter (`api.frankfurter.dev`, no
key; rates cached as `fx:usd:<day>`). A few currencies the ECB doesn't publish (AED, SAR, EGP, NGN, …) use fixed
rough rates, and the amount converted that way is kept as `approx`. Each record also keeps the proceeds in every
currency (`local`), so they can be converted again later. A day isn't stored until its rates are out.

Every 6 hours (with the analytics pass), the runner reads up to `salesPerPass` (40) sales, 40 subscription and 40 event
reports: first the last 5 days, then the oldest days Apple still has, since those expire first. Subscription and event days
go newest first and stop after 14 days in a row without a report (before the first subscription). A report Apple
doesn't have (a day without sales) is remembered and not asked again, except in the last 5 days. A first backfill
is about 400 requests; `analytics sales sync --all` does it in one go (about 10 minutes).

State: `sales:<appId>:day:<day>`, `sales:<appId>:year:<year>`, `subs:<appId>:day:<day>`, `subev:<appId>:day:<day>`,
`sales:<appId>:name`, `sales:got:<day|subs|events|year>:<date>` (read or missing), `sales:skus`, `sales:synced`, `fx:usd:<day>` and
`fx:through`. Nothing is pruned.

The board's Growth view shows it ([board](board.md)): a Revenue section (proceeds by month stacked by kind,
this month against the same days last month, the last 30 days, the recurring run-rate, trial conversion over 28
days, yearly totals, each app's last four months, and each app's trials and cancellations over 28 days), and on each
App Store app its proceeds by month, active subscriptions (with plans in the table view), and trials, conversion,
renewals and cancellations by week (by plan and price in the table view). Conversion is converted ÷ (converted +
trial cancels).

It needs the vendor number (App Store Connect → Payments and Financial Reports): `analytics.vendorNumber` in the
runner config, or `ASC_VENDOR_NUMBER` in `runner.env`. The API key needs Sales and Reports access (isobot's Admin
key has it).

## What it doesn't cover

Apple's data stops at the App Store and StoreKit: impressions, page views, downloads, purchases and subscription
events. It has no real paywall views (repeat views, or the paywall opened from Settings), no paywall variants, and
nothing about what people do inside the app between install and purchase. The apps removed their own analytics on
2026-10-29 and stay that way: the first-run funnel above is built from Apple's numbers only.

## Configuration

```json
"analytics": {}
```

Optional: `apps` (App Store ids, a subset of `appStore.apps`; default all), `backfillDays` (1-180, default 35),
`vendorNumber` (Sales and Trends; or `ASC_VENDOR_NUMBER` in `runner.env`) and `salesPerPass` (1-400, default 40).

## Commands

```sh
npm run runner -- analytics sync          # download new reports now
npm run runner -- analytics checkin       # print the check-in's App Store section
npm run runner -- analytics vox.md 30     # an app's last 30 days as JSON
npm run runner -- analytics               # every app's last 7 days
npm run runner -- analytics sales         # what's stored of the Sales and Trends reports
npm run runner -- analytics sales sync --all   # read every report still to read (a first backfill)
```

## Google Play

`runner/src/playAnalytics.ts` reads Play Console's monthly bulk reports from Cloud Storage
(`aso.playReportsBucket`, `gs://pubsite_prod_<developer id>`) with the ASO train's service account, every 6 hours,
for every Play app of the [ASO train](aso.md): store listing visitors and installs from the listing by traffic source
(`stats/store_performance/…_traffic_source.csv`), daily user installs (`stats/installs/…_overview.csv`), and orders
from the account's sales report (`sales/salesreport_<month>.zip`: first orders, renewals by their `..N` order
number, refunds, and charged amounts by buyer currency, since Play doesn't convert them). Files are UTF-16 CSV and
read by column name; only files whose generation changed are downloaded again.

Ratings come from `stats/ratings/…_overview.csv`: per day, the average of that day's new ratings (0.0 when there
were none) and the app's overall average. Play gives no count of ratings, so isobot reports the overall average,
the days with new ratings (in the last 7 and 30 days of the report, which lags the others by a few days) and the
newest day's average, never a number of ratings. Play writes no ratings file before an app's first rating. The
overall average in the report can move back and forth between days (Play restates it); it's shown as Play gives it.
Ratings are read for the last 5 months so the board's 120 days are covered.

- **Daily check-in**: a **Google Play ratings** section with a line per Play app (or "no ratings report yet").
  Lines ride along; a day in the last 14 whose new ratings averaged 2★ or less posts a check-in on its own,
  once per day (`playstats:<package>:lowrating:<date>`).
- **Board**: the Growth view's Play funnel carries `ratingDaily` and `ratingTotal`; each repo shows a
  "Google Play rating" chart and a "Play rating" tile.
- **Weekly ASO report**: the Google Play line adds the overall rating and the days with new ratings.

It feeds the weekly ASO report's Google Play section and the Play listing research. A 403 (Play shares the bucket
with a newly invited account within about a day) is kept in `playstats:error`, shown in the report instead of the
numbers, and retried each pass. State: `playstats:<package>:day:<date>` (kept 400 days) and `playstats:gen:<file>`.

```sh
npm run runner -- analytics play sync   # read Play Console's reports now
npm run runner -- analytics play        # each Play app's week, or why the reports can't be read
npm run runner -- analytics play ratings  # each Play app's ratings
```
