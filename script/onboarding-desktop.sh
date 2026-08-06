#!/usr/bin/env bash
# Launch the desktop app in a throwaway profile with onboarding v1 enabled.
#
# Everything the onboarding flow reads lives in two places, and both are
# redirected here so a reset never touches your real state:
#
#   CLAXEDO_DESKTOP_USER_DATA_DIR -> Electron userData: renderer localStorage
#     (all `opencode.*` persisted UI state, incl. onboarding dismissals),
#     window state, caches.
#   CLAXEDO_DATA_DIR              -> embedded claxedo-server state: claxedo.db,
#     authority.db, workgraph-v2.db, credentials/, workspaces.json,
#     opencode-engine/, agent-core/, opencode-config/, and the engine's
#     redirected XDG dirs (opencode-xdg-{data,config,cache}).
#
# Your ~/.claxedo and ~/.local/share/opencode are left alone. To reset the real
# ones instead, use script/reset-claxedo-state.sh.
#
# Usage:
#   script/onboarding-desktop.sh                  # wipe profile, launch
#   script/onboarding-desktop.sh --keep           # resume profile, launch
#   script/onboarding-desktop.sh --reset-only     # wipe profile, don't launch
#   script/onboarding-desktop.sh --print-env      # show the env, change nothing
#   script/onboarding-desktop.sh --profile ramp2  # a second named profile
#   script/onboarding-desktop.sh --no-credentials # also fake $HOME (see below)
#   script/onboarding-desktop.sh --force          # skip the running-app guard
#
# --no-credentials: the server discovers provider logins from your real home
# dir (~/.local/share/opencode/auth.json, ~/.codex/auth.json + accounts/,
# ~/.claude/.credentials.json) when you press Discover in the Connect-AI step.
# A fresh profile already starts with zero *saved* credentials, so you only
# need this to test the "nothing found" path. It points $HOME at the profile,
# which also hides ~/.gitconfig, ~/.ssh and every CLI's own config from any
# agent you run inside the app — use it for the Connect-AI step, not for a
# full end-to-end session run.
set -euo pipefail

PROFILE_NAME="default"
PROFILE_ROOT="${CLAXEDO_ONBOARDING_ROOT:-$HOME/.claxedo-onboarding}"
KEEP=0
RESET_ONLY=0
PRINT_ENV=0
NO_CREDENTIALS=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --reset-only) RESET_ONLY=1 ;;
    --print-env) PRINT_ENV=1 ;;
    --no-credentials) NO_CREDENTIALS=1 ;;
    --force) FORCE=1 ;;
    --profile)
      [ $# -ge 2 ] || { echo "error: --profile needs a name" >&2; exit 1; }
      PROFILE_NAME="$2"
      shift
      ;;
    -h|--help)
      sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//;s/^#$//'
      exit 0
      ;;
    *)
      echo "unknown argument: $1 (try --help)" >&2
      exit 1
      ;;
  esac
  shift
done

case "$PROFILE_NAME" in
  ""|*/*|.|..)
    echo "error: --profile must be a plain directory name, got '$PROFILE_NAME'" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$PROFILE_ROOT/$PROFILE_NAME"
USER_DATA_DIR="$PROFILE/userdata"
DATA_DIR="$PROFILE/claxedo"
FAKE_HOME="$PROFILE/home"

if [ "$PRINT_ENV" = 1 ]; then
  echo "CLAXEDO_DESKTOP_USER_DATA_DIR=$USER_DATA_DIR"
  echo "CLAXEDO_DATA_DIR=$DATA_DIR"
  echo "CLAXEDO_STATE_DIR=$DATA_DIR/state"
  echo "VITE_CLAXEDO_ONBOARDING_V1=true"
  [ "$NO_CREDENTIALS" = 1 ] && echo "HOME=$FAKE_HOME"
  exit 0
fi

# SQLite stores under both dirs are held open while the app runs; wiping or
# re-launching underneath a live instance corrupts them.
if [ "$FORCE" = 0 ]; then
  if pgrep -f "Claxedo Dev.app/Contents/MacOS" >/dev/null 2>&1 ||
     pgrep -f "electron-vite dev" >/dev/null 2>&1; then
    echo "error: a desktop dev instance is already running — quit it first (or pass --force)." >&2
    exit 1
  fi
fi

if [ "$KEEP" = 0 ]; then
  # Belt-and-braces: only ever delete inside the profile root.
  case "$PROFILE" in
    "$PROFILE_ROOT"/?*) ;;
    *) echo "error: refusing to delete '$PROFILE' (outside $PROFILE_ROOT)" >&2; exit 1 ;;
  esac
  if [ -e "$PROFILE" ]; then
    echo "wiping $PROFILE"
    rm -rf "$PROFILE"
  fi
fi

mkdir -p "$USER_DATA_DIR" "$DATA_DIR"
[ "$NO_CREDENTIALS" = 1 ] && mkdir -p "$FAKE_HOME"

if [ "$RESET_ONLY" = 1 ]; then
  echo "profile reset: $PROFILE (not launching)"
  exit 0
fi

# The embedded server reads its configuration from the environment it inherits
# and nothing else — nothing in the tree loads a .env file. Without this the
# provider and GitHub keys are simply absent, and the features that need them
# fail as though they were broken rather than unconfigured.
#
# Sourced BEFORE the profile exports below, so a value the profile owns (the
# throwaway data dirs) is never overwritten by a stale one in the file.
. "$REPO_ROOT/script/load-server-env.sh"
claxedo_load_server_env "$REPO_ROOT"

export CLAXEDO_DESKTOP_USER_DATA_DIR="$USER_DATA_DIR"
export CLAXEDO_DATA_DIR="$DATA_DIR"
export CLAXEDO_STATE_DIR="$DATA_DIR/state"
export VITE_CLAXEDO_ONBOARDING_V1=true

# A server URL/token inherited from the shell would point the desktop app at an
# already-onboarded control plane instead of its own embedded one.
unset CLAXEDO_SERVER_URL CLAXEDO_AUTH_TOKEN

if [ "$NO_CREDENTIALS" = 1 ]; then
  export HOME="$FAKE_HOME"
  echo "credential discovery: blocked (HOME=$FAKE_HOME)"
else
  echo "credential discovery: live (Discover will find your real provider logins)"
fi

echo "profile:   $PROFILE"
echo "userData:  $USER_DATA_DIR"
echo "data dir:  $DATA_DIR"
echo "onboarding v1: on"
echo

# Run from inside the package: `bun run dev` triggers the predev build (patched
# opencode CLI, embedded engine, bundled claxedo-server) and root-level --cwd
# forms have bitten this repo before.
cd "$REPO_ROOT/packages/claxedo-desktop"
exec bun run dev
