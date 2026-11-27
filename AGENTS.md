# Agents

- `~/dev/isobot` is the live checkout the runner runs from, and other sessions share it. Don't edit it: make changes in your own git worktree (`git worktree add ../isobot-<topic> -b <branch> origin/main`) and open a PR from there.
- The runner keeps that checkout on `origin/main` itself: after a merge it pulls, rebuilds, deploys the board and restarts when idle ([self-update](docs/runner.md#self-update)). Leave it clean and on `main`, or it stops updating.
