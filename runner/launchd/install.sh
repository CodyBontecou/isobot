#!/bin/sh
# Builds the runner and (re)installs it as a LaunchAgent for the current user.
#   runner/launchd/install.sh            install or update, then start
#   runner/launchd/install.sh uninstall  stop and remove
set -eu

LABEL="tech.isolated.isobot-runner"
RUNNER="$(cd "$(dirname "$0")/.." && pwd)"
ISOBOT_HOME="${ISOBOT_HOME:-$HOME/Library/Application Support/isobot}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. State in $ISOBOT_HOME is kept."
  exit 0
fi

NODE="$(command -v node)" || { echo "node is not on PATH" >&2; exit 1; }
CLAUDE="$(command -v claude)" || { echo "claude (Claude Code) is not on PATH" >&2; exit 1; }
GIT="$(command -v git)"

if [ ! -f "$ISOBOT_HOME/runner.env" ]; then
  echo "Missing $ISOBOT_HOME/runner.env; copy runner/runner.env.example there and fill it in." >&2
  exit 1
fi

# The agent starts with a minimal PATH; give it the directories of the tools builds need.
TOOL_PATH="$(dirname "$NODE"):$(dirname "$CLAUDE"):$(dirname "$GIT"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Toolchains repo checks call directly (cargo for Rust cores, rg in CI scripts), wherever they live.
for tool in cargo rg; do
  found="$(command -v "$tool" 2>/dev/null)" && TOOL_PATH="$(dirname "$found"):$TOOL_PATH"
done

(cd "$RUNNER" && npm ci --silent && npm run -s build)
mkdir -p "$ISOBOT_HOME/logs" "$HOME/Library/LaunchAgents"
chmod 600 "$ISOBOT_HOME/runner.env"

sed -e "s#__NODE__#$NODE#g" -e "s#__RUNNER__#$RUNNER#g" -e "s#__PATH__#$TOOL_PATH#g" -e "s#__HOME__#$ISOBOT_HOME#g" \
  "$RUNNER/launchd/$LABEL.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

# bootout returns before the old instance has fully stopped; bootstrap then fails with error 5.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
i=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
launchctl bootstrap "$DOMAIN" "$PLIST" || { sleep 3; launchctl bootstrap "$DOMAIN" "$PLIST"; }
echo "Installed $LABEL. Logs: $ISOBOT_HOME/logs/runner.log"
echo "Status: node \"$RUNNER/dist/main.js\" status   Pause: node \"$RUNNER/dist/main.js\" pause"
