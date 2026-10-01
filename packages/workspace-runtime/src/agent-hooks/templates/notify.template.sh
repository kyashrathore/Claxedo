#!/bin/bash
{{MARKER}}
# Forward provider JSON unchanged. The runtime owns normalization and state.
[ -z "$CLAXEDO_TAB_ID" ] && exit 0

# A config firing under another agent is not this terminal's lifecycle.
HARNESS=""
case "${1:-}" in
  --harness=*) HARNESS="${1#--harness=}"; shift ;;
esac
AGENT="$CLAXEDO_AGENT"
case "$AGENT" in
{{ALIASES}}
esac
if [ -n "$HARNESS" ]; then
  if [ -z "$AGENT" ]; then
{{REPLAY_GUARDS}}
    CLAXEDO_AGENT="$HARNESS"
  elif [ "$HARNESS" != "$AGENT" ]; then
    exit 0
  fi
fi

if [ -n "$1" ]; then
  INPUT="$1"
elif [ -t 0 ]; then
  exit 0
else
  INPUT=$(cat)
fi
[ -z "$INPUT" ] && exit 0

HOOK_PORT="${CLAXEDO_SERVER_PORT:-${CLAXEDO_PORT:-{{PORT}}}}"
HOOK_URL="http://127.0.0.1:${HOOK_PORT}/api/wr/hook/agent-lifecycle"

# Complete delivery before returning to the provider. Failed requests must not
# consume a local settled-state marker and suppress a later delivery attempt.
curl -fsS "$HOOK_URL" \
  --request POST \
  --connect-timeout 1 \
  --max-time 2 \
  --header "x-workspace-id: $CLAXEDO_WORKSPACE_ID" \
  --header "Authorization: Bearer $CLAXEDO_AGENT_HOOK_TOKEN" \
  --data-urlencode "tabId=$CLAXEDO_TAB_ID" \
  --data-urlencode "terminalId=$CLAXEDO_TERMINAL_ID" \
  --data-urlencode "workspaceId=$CLAXEDO_WORKSPACE_ID" \
  --data-urlencode "provider=$CLAXEDO_AGENT" \
  --data-urlencode "providerEvent=$INPUT" \
  >/dev/null
