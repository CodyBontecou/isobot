# Play rollouts

Google Play never raises a staged rollout's percentage by itself: a release sent to 20% of users stays at 20%
until someone changes it. The rollout train (`runner/src/playRollout.ts`) moves it forward the way the App Store's
7-day phased release does, and halts it when the new version crashes.

## What it does

Every 3 hours, for each repo with a Play package (`aso.play.packageName`), it reads the production track:

| Release | What happens |
| --- | --- |
| Rolling out (`inProgress`) and live | After its hold time at the current stage, moves to the next one: 20% for 2 days, then 50% for 5 days, then everyone |
| In Google's review | Waits |
| Approved but not published | Waits: the app has managed publishing on, so someone presses Publish in Play Console |
| Halted | Waits until someone resumes it |
| Draft, completed, Wear OS tracks | Left alone |

Hold time counts from when isobot first saw the release live at that percentage, so a percentage someone changes
by hand starts its hold again.

On every pass (not only before a step) it checks the version's crashes and **halts** the rollout when:

- Play has a crash or ANR cluster that first appeared in this version and reached `minUsers` users (default 2), or
- Play reports a user-perceived crash or ANR rate for this version above its bad-behavior threshold (1.09% and 0.47%),
  from at least 50 users. Play only returns per-version rates above its privacy threshold, so small apps rarely have them.

When it can't read the track or the crashes, it waits and posts the error once. Each step and each halt is posted
to the staff channel and recorded as a `play_rollout` event.

A halt keeps the version for people who already updated; nobody else gets it. Ship a fixed version, or resume this
one in Play Console (Manage rollout → Resume) or with `play rollout resume <package>`, which also accepts the crashes
it halted for so they don't halt it again. The [crash audit](crashes.md) files the crash as an issue either way.

## Config

```json
"playRollout": {}
```

Off without the block. It uses the ASO train's Google service account (`aso.googleKey`), which needs "Release to
production" in Play Console. Optional settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `stages` | `[0.2, 0.5, 1]` | Rollout fractions in order, ending at 1 |
| `holdDays` | `[2, 5]` | Days at each stage but the last |
| `minUsers` | `2` | Users a new crash or ANR cluster needs to halt the rollout |

## Commands

```sh
npm run runner -- play rollout                    # what the next pass would do (reads Play only)
npm run runner -- play rollout run                # do it now
npm run runner -- play rollout resume <package>   # resume a halted rollout and accept its crashes
```

Releases start at whatever percentage the release workflow or Play Console gives them; the train only moves them
forward.
