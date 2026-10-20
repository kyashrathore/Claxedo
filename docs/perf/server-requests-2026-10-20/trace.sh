#!/bin/bash
# Prints every request the staging control plane logged as slow (over 1 s) with its Server-Timing
# breakdown, live, while a person walks the sign-in, connect and account flows in the browser.
# Needs `wrangler login` with access to the staging account. Ctrl-C to stop.
#
#   ./trace.sh | tee trace.txt
cd "$(dirname "$0")/../../../packages/claxedo-server" || exit 1
bunx wrangler tail claxedo-user-deployed-locked-staging --format json --search "[timing]" \
  | jq -r --unbuffered '.logs[]?.message[]? | select(type == "string" and startswith("[timing]"))'
