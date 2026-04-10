#!/bin/bash
{{MARKER}}
set -uo pipefail

INPUT="{}"
if [ -t 0 ]; then
  : # INPUT already defaulted
else
  # Use head -1 instead of read -t because macOS /bin/bash 3.2
  # mishandles fractional timeouts on pipes, returning empty even
  # when data is available.
  INPUT=$(head -1 2>/dev/null || true)
  [ -z "$INPUT" ] && INPUT="{}"
fi

# Output required JSON immediately to unblock Gemini CLI
printf '{}\n'

# Send notification in background
bash "{{NOTIFY_PATH}}" "$INPUT" >/dev/null 2>&1 &
exit 0
