#!/bin/bash
{{MARKER}}
set -uo pipefail

INPUT="{}"
if [ -t 0 ]; then
  : # INPUT already defaulted
else
  # read with timeout to avoid blocking
  IFS= read -r -t 0.1 INPUT 2>/dev/null || true
  [ -z "$INPUT" ] && INPUT="{}"
fi

# Output required JSON immediately to unblock Gemini CLI
printf '{}\n'

# Send notification in background
bash "{{NOTIFY_PATH}}" "$INPUT" >/dev/null 2>&1 &
exit 0
