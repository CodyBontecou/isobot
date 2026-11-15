#!/bin/sh
# Adds (or replaces) a mailbox for email triage, taking its app password from the clipboard so it
# is never typed, printed, or left in shell history. Then clears the clipboard and restarts the runner.
#   1. Create an app password (Gmail: https://myaccount.google.com/apppasswords) and copy it.
#   2. sh runner/scripts/add-mail-account.sh you@gmail.com
set -eu

ADDRESS="${1:?usage: add-mail-account.sh <email address>}"
ISOBOT_HOME="${ISOBOT_HOME:-$HOME/Library/Application Support/isobot}"
ENV_FILE="$ISOBOT_HOME/runner.env"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }

pbpaste | ADDRESS="$ADDRESS" ENV_FILE="$ENV_FILE" python3 -c '
import os, re, sys
address, path = os.environ["ADDRESS"].strip(), os.environ["ENV_FILE"]
password = re.sub(r"\s+", "", sys.stdin.read())
if not re.fullmatch(r"[a-z]{16}", password):
    sys.exit("The clipboard does not hold a 16-letter app password; copy it from the page and run this again.")
lines = open(path).read().splitlines()
suffixes = ["", "_2", "_3", "_4", "_5", "_6", "_7", "_8", "_9"]
users = {}
for line in lines:
    m = re.match(r"ISOBOT_IMAP_USER(_\d)?=(.*)", line)
    if m: users[m.group(1) or ""] = m.group(2).strip()
slot = next((s for s, u in users.items() if u.lower() == address.lower()), None)
if slot is None:
    slot = next((s for s in suffixes if s not in users), None)
    if slot is None: sys.exit("All 9 mailbox slots are in use.")
keep = [l for l in lines if not re.match(rf"ISOBOT_IMAP_(USER|PASSWORD){re.escape(slot)}=", l)]
keep += [f"ISOBOT_IMAP_USER{slot}={address}", f"ISOBOT_IMAP_PASSWORD{slot}={password}"]
fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: f.write("\n".join(keep) + "\n")
os.replace(path + ".tmp", path)
print("Saved " + address + " as mailbox " + (slot.strip("_") or "1") + ".")
'
printf '' | pbcopy
echo "Clipboard cleared."
[ -n "${ISOBOT_NO_RESTART:-}" ] && exit 0
launchctl kickstart -k "gui/$(id -u)/tech.isolated.isobot-runner" 2>/dev/null && echo "Runner restarted." || echo "Runner not installed as a LaunchAgent; restart it yourself."
