#!/usr/bin/env bash
# Reset local Claxedo state for a fresh-start / onboarding test run.
#
# Moves ~/.claxedo and ~/.local/share/opencode into a timestamped backup under
# ~/.claxedo-resets/ (keeps the 3 most recent), preserving provider logins
# (~/.local/share/opencode/auth.json, ~/.claxedo/credentials) unless --full.
#
# Usage:
#   script/reset-claxedo-state.sh           # reset, keep provider auth
#   script/reset-claxedo-state.sh --full    # reset including auth/credentials
#   script/reset-claxedo-state.sh --purge   # delete outright, no backup
#
# Browser-side note: the web app also keeps UI state in localStorage/IndexedDB
# for http://localhost:4444 — clear site data there (or use a fresh profile /
# private window) for a truly blank onboarding run.
set -euo pipefail

FULL=0
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

CLAXEDO_DIR="$HOME/.claxedo"
OPENCODE_DIR="$HOME/.local/share/opencode"
BACKUP_ROOT="$HOME/.claxedo-resets"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/$STAMP"

# The server (:3001) and embedded/standalone engine (:4096) hold the sqlite
# stores open — resetting under them corrupts state and they recreate dirs
# mid-move. The desktop app embeds the same server.
for port in 3001 4096; do
  if lsof -ti tcp:"$port" >/dev/null 2>&1; then
    echo "error: something is listening on :$port — stop claxedo-server / the engine / the desktop app first." >&2
    exit 1
  fi
done

moved_any=0
for dir in "$CLAXEDO_DIR" "$OPENCODE_DIR"; do
  [ -e "$dir" ] || continue
  moved_any=1
  if [ "$PURGE" = 1 ]; then
    echo "deleting $dir"
    rm -rf "$dir"
  else
    mkdir -p "$BACKUP_DIR"
    echo "moving $dir -> $BACKUP_DIR/$(basename "$dir")"
    mv "$dir" "$BACKUP_DIR/$(basename "$dir")"
  fi
done

if [ "$moved_any" = 0 ]; then
  echo "nothing to reset: neither $CLAXEDO_DIR nor $OPENCODE_DIR exists."
  exit 0
fi

# Restore provider logins so a state reset doesn't force re-authenticating
# every model provider. --full skips this for testing the auth flow itself.
if [ "$FULL" = 0 ] && [ "$PURGE" = 0 ]; then
  if [ -f "$BACKUP_DIR/opencode/auth.json" ]; then
    mkdir -p "$OPENCODE_DIR"
    cp "$BACKUP_DIR/opencode/auth.json" "$OPENCODE_DIR/auth.json"
    echo "kept provider auth: $OPENCODE_DIR/auth.json"
  fi
  if [ -d "$BACKUP_DIR/.claxedo/credentials" ]; then
    mkdir -p "$CLAXEDO_DIR"
    cp -R "$BACKUP_DIR/.claxedo/credentials" "$CLAXEDO_DIR/credentials"
    echo "kept credentials: $CLAXEDO_DIR/credentials"
  fi
elif [ "$FULL" = 1 ] && [ "$PURGE" = 0 ]; then
  echo "--full: auth/credentials NOT restored (backed up in $BACKUP_DIR)"
fi

# Prune old backups, keep the 3 most recent. (tail -n +4 skips the newest 3;
# BSD head has no negative -n.)
if [ -d "$BACKUP_ROOT" ]; then
  ls -1 "$BACKUP_ROOT" | sort -r | tail -n +4 | while read -r old; do
    [ -n "$old" ] || continue
    echo "pruning old backup $BACKUP_ROOT/$old"
    rm -rf "${BACKUP_ROOT:?}/$old"
  done
fi

echo
if [ "$PURGE" = 1 ]; then
  echo "done. state deleted."
else
  echo "done. restore with:  mv $BACKUP_DIR/.claxedo ~/.claxedo && mv $BACKUP_DIR/opencode ~/.local/share/opencode"
fi
echo "remember: clear browser site data for http://localhost:4444 for a fully blank run."
