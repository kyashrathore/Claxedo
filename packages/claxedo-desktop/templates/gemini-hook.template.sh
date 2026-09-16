#!/bin/bash
{{MARKER}}
set -uo pipefail

# Preserve the full provider payload and finish delivery before the next hook.
# notify.sh bounds HTTP delivery to two seconds; status reporting does not
# change the provider's tool decision.
if [ ! -t 0 ]; then
  INPUT=$(cat)
  if [ -n "$INPUT" ]; then
    bash "{{NOTIFY_PATH}}" --harness=gemini "$INPUT" >/dev/null 2>&1 || true
  fi
fi
printf '{}\n'
