#!/usr/bin/env bash
set -euo pipefail

SOURCE=""
INTERVAL_MINUTES="5"
ENV_FILE="$HOME/.sovereign-vault/device.env"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="com.sovereign-vault.import"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/SovereignVault"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --interval-minutes) INTERVAL_MINUTES="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --repo) REPO_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SOURCE" ]]; then
  echo "--source is required, for example: --source \"$HOME/Proton Drive/VaultInbox\"" >&2
  exit 1
fi
if [[ "$INTERVAL_MINUTES" != "5" && "$INTERVAL_MINUTES" != "10" ]]; then
  echo "--interval-minutes must be 5 or 10" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<ENVEOF
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
SUPABASE_ACCESS_TOKEN=USER_JWT_OR_SESSION_ACCESS_TOKEN
SUPABASE_RAW_BUCKET=vault-raw
VAULT_MASTER_KEY_B64=REPLACE_WITH_LOCAL_ONLY_SECRET
VAULT_LOCAL_AUDIT_LOG=$HOME/.sovereign-vault/audit.jsonl
ENVEOF
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Fill it in, then rerun this command." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

for required in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_ACCESS_TOKEN SUPABASE_RAW_BUCKET VAULT_MASTER_KEY_B64 VAULT_LOCAL_AUDIT_LOG; do
  if [[ -z "${!required:-}" ]]; then
    echo "$required is missing from $ENV_FILE" >&2
    exit 1
  fi
done

NODE_BIN="$(command -v node)"
export NODE_BIN REPO_DIR SOURCE INTERVAL_MINUTES START_INTERVAL_SECONDS LOG_DIR
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 20+ is required. Install from https://nodejs.org or Homebrew." >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR" "$(dirname "$VAULT_LOCAL_AUDIT_LOG")"
START_INTERVAL_SECONDS=$((INTERVAL_MINUTES * 60))
python3 - "$REPO_DIR/deploy/macos/com.sovereign-vault.import.plist.template" "$PLIST_PATH" <<'PY'
import os, sys
from pathlib import Path
src, dst = map(Path, sys.argv[1:3])
values = {
    "__NODE__": os.environ["NODE_BIN"],
    "__REPO__": os.environ["REPO_DIR"],
    "__SOURCE__": os.environ["SOURCE"],
    "__INTERVAL__": os.environ["INTERVAL_MINUTES"],
    "__SUPABASE_URL__": os.environ["SUPABASE_URL"],
    "__SUPABASE_ANON_KEY__": os.environ["SUPABASE_ANON_KEY"],
    "__SUPABASE_ACCESS_TOKEN__": os.environ["SUPABASE_ACCESS_TOKEN"],
    "__SUPABASE_RAW_BUCKET__": os.environ["SUPABASE_RAW_BUCKET"],
    "__VAULT_MASTER_KEY_B64__": os.environ["VAULT_MASTER_KEY_B64"],
    "__VAULT_LOCAL_AUDIT_LOG__": os.environ["VAULT_LOCAL_AUDIT_LOG"],
    "__START_INTERVAL_SECONDS__": os.environ["START_INTERVAL_SECONDS"],
    "__LOG_DIR__": os.environ["LOG_DIR"],
}
text = src.read_text()
for key, value in values.items():
    text = text.replace(key, value)
dst.write_text(text)
PY
chmod 600 "$PLIST_PATH"
launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"
echo "Installed $PLIST_PATH"
echo "First import source: $SOURCE"
echo "Runs every $INTERVAL_MINUTES minutes while this Mac user is logged in."
