#!/bin/bash
{{MARKER}}
# Event name is supplied by the native hooks.json registration; retain its
# complete JSON payload inside the envelope sent to the canonical normalizer.
case "${1:-}" in
  PreInvocation|Stop) ;;
  *) exit 1 ;;
esac
if [ -n "${CLAXEDO_TAB_ID:-}" ] && [ ! -t 0 ]; then
  INPUT=$(cat)
  if [ -n "$INPUT" ]; then
    { printf '{"provider":"antigravity","hook_event_name":"%s","event":' "$1"; printf '%s' "$INPUT"; printf '}'; } |
      CLAXEDO_AGENT=antigravity bash "{{NOTIFY_PATH}}" --harness=antigravity >/dev/null 2>&1
  fi
fi
# Observe lifecycle without injecting steps or asking the loop to continue.
printf '{}\n'
