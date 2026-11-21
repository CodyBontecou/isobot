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
Event and Subscription State, all Standard) and downloads the ones it hasn't read, newest first, at most 60 per app
and pass. A normal day costs about 14 requests per app. The first pass backfills `backfillDays` (35) of
processing dates over a few passes. A 429 from App Store Connect ends the pass for every app, since the rate limit
belongs to the API key that releases and the ASO train also use.

Apple restates recent days: the instance processed on day P has rows for P-1 back to P-3 (sessions: P-6). So each
day keeps, per report, the numbers from the newest processing date that covered it. The newest complete day is
usually two days ago. Apple drops rows under its privacy thresholds, so small numbers are approximate, and the
Detailed reports are often empty for small apps; the runner reads only the Standard ones.

State is in `runner.sqlite` cursors: `analytics:<appId>:day:<date>` (kept 400 days), `…:request`, `…:reports`,
`…:seen` (instance ids read) and `…:name` (the app name Apple reports).

## What it doesn't cover

Apple's data stops at the App Store and StoreKit: impressions, page views, downloads, purchases and subscription
events. It has no real paywall views (repeat views, or the paywall opened from Settings), no paywall variants, and
nothing about what people do inside the app between install and purchase. The apps removed their own analytics on
2026-10-29 and stay that way: the first-run funnel above is built from Apple's numbers only.

## Configuration

```json
"analytics": {}
```

Optional: `apps` (App Store ids, a subset of `appStore.apps`; default all) and `backfillDays` (1-180, default 35).

## Commands

```sh
npm run runner -- analytics sync          # download new reports now
npm run runner -- analytics checkin       # print the check-in's App Store section
npm run runner -- analytics vox.md 30     # an app's last 30 days as JSON
npm run runner -- analytics               # every app's last 7 days
```

## Google Play

`runner/src/playAnalytics.ts` reads Play Console's monthly bulk reports from Cloud Storage
(`aso.playReportsBucket`, `gs://pubsite_prod_<developer id>`) with the ASO train's service account, every 6 hours,
for every Play app of the [ASO train](aso.md): store listing visitors and installs from the listing by traffic source
(`stats/store_performance/…_traffic_source.csv`), daily user installs (`stats/installs/…_overview.csv`), and orders
from the account's sales report (`sales/salesreport_<month>.zip`: first orders, renewals by their `..N` order
number, refunds, and charged amounts by buyer currency, since Play doesn't convert them). Files are UTF-16 CSV and
read by column name; only files whose generation changed are downloaded again.

It feeds the weekly ASO report's Google Play section and the Play listing research. A 403 (Play shares the bucket
with a newly invited account within about a day) is kept in `playstats:error`, shown in the report instead of the
numbers, and retried each pass. State: `playstats:<package>:day:<date>` (kept 400 days) and `playstats:gen:<file>`.

```sh
npm run runner -- analytics play sync   # read Play Console's reports now
npm run runner -- analytics play        # each Play app's week, or why the reports can't be read
```
