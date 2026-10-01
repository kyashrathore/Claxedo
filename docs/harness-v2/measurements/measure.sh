#!/usr/bin/env bash
# P0.7 re-measurement for the harness-rebuild plan. Prints "name value" lines.
# Usage: ./measure.sh [repo-root]   dev numbers come from ./_devtree if present.
set -u
SELF="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${1:-$SELF/../../..}" && pwd)"
DEVTREE="$SELF/_devtree"
DEVREV=37563dc802576789b73218b64a5778069d38a7e2
PKGS="agent-sdk-runtime agent-event-runtime agent-runtime-contract opencode-server-adapter"
say() { printf '%s%s %s\n' "$PFX" "$1" "$2"; }
pl() { find "packages/$1/src" -name '*.ts' ! -name '*.test.ts' ! -path '*/test-utils/*' ! -path '*/test-support/*' ! -name 'test-temp-dir.ts' 2>/dev/null | xargs cat 2>/dev/null | wc -l | tr -d ' '; }
tl() { find "packages/$1/src" -name '*.ts' \( -name '*.test.ts' -o -path '*/test-utils/*' -o -path '*/test-support/*' -o -name 'test-temp-dir.ts' \) 2>/dev/null | xargs cat 2>/dev/null | wc -l | tr -d ' '; }
first() { for f in "$@"; do [ -f "$f" ] && { echo "$f"; return; }; done; }
wl() { f=$(first "$@"); [ -n "$f" ] && wc -l < "$f" | tr -d ' ' || echo MISSING; }
cl() { grep -hvcE '^\s*(//|\*|/\*|\*/)' "$@" 2>/dev/null | awk '{s+=$1}END{print s+0}'; }
catd() { find "$1" -name '*.ts' ! -name '*.test.ts' 2>/dev/null | xargs cat 2>/dev/null | wc -l | tr -d ' '; }

measure() {
  R="$1"; PFX="$2"; cd "$R" || return 1
  SDKS=packages/agent-sdk-runtime/src
  AER=packages/agent-event-runtime/src
  [ -f "$AER/harnesses/claude/adapter.ts" ] && H=$AER/harnesses || H=$SDKS/harnesses
  t=0; for p in $PKGS; do say "prod.$p" "$(pl $p)"; t=$((t+$(pl $p))); done
  say "prod.four_packages" "$t"
  t=0; for p in $PKGS; do t=$((t+$(tl $p))); done; say "test_lines.four_packages" "$t"
  TFS=$(find packages/agent-sdk-runtime/src packages/agent-event-runtime/src packages/agent-runtime-contract/src packages/opencode-server-adapter/src -name '*.test.ts' 2>/dev/null)
  say "test_files.four_packages" "$(echo "$TFS" | grep -c .)"
  say "test_cases.test(" "$(echo "$TFS" | xargs grep -c 'test(' 2>/dev/null | awk -F: '{s+=$2}END{print s}')"
  say "test_cases.it_or_test" "$(echo "$TFS" | xargs grep -cE '(^|[^a-zA-Z])(test|it)\(' 2>/dev/null | awk -F: '{s+=$2}END{print s}')"
  say "test_assertions.expect(" "$(echo "$TFS" | xargs grep -c 'expect(' 2>/dev/null | awk -F: '{s+=$2}END{print s}')"
  say "prod.process-ownership" "$(pl process-ownership)"
  say "prod.harness" "$(pl harness)"
  PO=packages/process-ownership/src
  say "po.launch" "$(find $SDKS/launch $PO/launch -name '*.ts' ! -name '*.test.ts' 2>/dev/null | xargs cat 2>/dev/null | wc -l | tr -d ' ')"
  say "po.process-observer" "$(wl $SDKS/process-observer.ts $PO/process-observer.ts)"
  say "po.process-lifecycle" "$(wl $SDKS/harnesses/shared/process-lifecycle.ts $PO/process-lifecycle.ts)"
  say "po.windows-process" "$(wl $SDKS/harnesses/shared/windows-process.ts $PO/windows-process.ts)"
  say "po.spawn-env" "$(wl $SDKS/harnesses/shared/spawn-env.ts $PO/spawn-env.ts)"
  say "host.runtime.ts" "$(wl $SDKS/runtime.ts)"
  say "host.runtime.dir" "$(catd $SDKS/runtime)"
  say "proj.client-presentation" "$(catd $AER/projections/client-presentation)"
  say "proj.compat-events" "$(wl $SDKS/compat-events.ts)"
  say "proj.turn+child" "$(cat $SDKS/harnesses/shared/turn-projection.ts $SDKS/harnesses/shared/child-event-routing.ts 2>/dev/null | wc -l | tr -d ' ')"
  say "proj.sse" "$(wl $SDKS/sse.ts packages/claxedo-helpers/src/sse.ts)"
  say "contracts.agent-event-runtime" "$(catd $AER/contracts)"
  say "tr.claude" "$(cl $H/claude/adapter.ts)"
  say "tr.claude.partial-json" "$(cl $H/claude/partial-json.ts)"
  say "tr.codex" "$(cl $H/codex/adapter.ts)"
  say "tr.cursor" "$(cl $H/cursor/adapter.ts)"
  say "tr.pi" "$(cl $H/pi/adapter.ts)"
  say "tr.acp" "$(cl $H/acp/classify-tool.ts $H/acp/diagnostics.ts $H/acp/event-translator.ts $H/acp/index.ts $H/acp/state.ts $H/acp/translate-session-update.ts $H/acp/types.ts $H/acp/validation.ts)"
  say "tr.shared.core" "$(catd $AER/core)"
  say "tr.shared.value" "$(wl $AER/value.ts)"
  say "tr.shared.tools" "$(cat $AER/harnesses/host-subagent.ts $AER/harnesses/tool-attachments.ts $AER/harnesses/tool-display.ts 2>/dev/null | wc -l | tr -d ' ')"
  say "protocol.codex.files" "$(find $AER/harnesses/codex/protocol -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')"
  say "protocol.codex.lines" "$(find $AER/harnesses/codex/protocol -name '*.ts' 2>/dev/null | xargs cat 2>/dev/null | wc -l | tr -d ' ')"
  SN=$(find $AER/harnesses/codex/protocol -name 'ServerNotification.ts' 2>/dev/null | head -1)
  say "codex.notification_methods" "$([ -n "$SN" ] && grep -oE '"method": "' "$SN" | wc -l | tr -d ' ' || echo MISSING)"
  say "factories.harness-factories" "$(catd $SDKS/harness-factories)"
  say "embedded.engine" "$(catd packages/workspace-runtime/src/opencode)"
  say "pi_pin_bundle" "$(cat $H/pi/executable.ts $H/pi/agent-dir.ts $H/pi/title-extension.ts $SDKS/harnesses/pi/executable.ts $SDKS/harnesses/pi/agent-dir.ts $SDKS/harnesses/pi/title-extension.ts 2>/dev/null | wc -l | tr -d ' ')"
  say "test_stores" "$(cat $SDKS/stores/memory.ts $SDKS/stores/sqlite.ts $SDKS/stores/persisted-rows.ts 2>/dev/null | wc -l | tr -d ' ')"
  say "glue.four_files" "$(cat $SDKS/adapters.ts $SDKS/log.ts $SDKS/target.ts $SDKS/paths.ts 2>/dev/null | wc -l | tr -d ' ')"
  say "plugin_adapters" "$(catd packages/claxedo-local-server/src/agent-plugins/runtime/adapters)"
  say "importers.adapters_subpath" "$(grep -rl '@claxedo/agent-sdk-runtime/adapters' packages/*/src 2>/dev/null | grep -vE '\.test\.|\.vitest\.' | sort -u | wc -l | tr -d ' ')"
  say "importers.log" "$(grep -rlE "from ['\"](\.+/)+log['\"]" $SDKS 2>/dev/null | sort -u | wc -l | tr -d ' ')"
  say "importers.target" "$(grep -rlE "from ['\"](\.+/)+target['\"]" $SDKS 2>/dev/null | sort -u | wc -l | tr -d ' ')"
  say "importers.paths" "$(grep -rlE "from ['\"](\.+/)+paths['\"]" $SDKS 2>/dev/null | sort -u | wc -l | tr -d ' ')"
  say "importers.process-observer_in_sdk" "$(grep -rlE "from ['\"][^'\"]*process-observer" $SDKS 2>/dev/null | grep -vE '\.test\.|test-utils|test-support' | sort -u | wc -l | tr -d ' ')"
  say "importers.launch_dir_in_sdk" "$(grep -rlE "from ['\"][^'\"]*launch['\"/]" $SDKS 2>/dev/null | grep -vE '\.test\.|test-utils|test-support|/launch/' | sort -u | wc -l | tr -d ' ')"
  say "importers.app_agent-event-runtime" "$(grep -rl '@claxedo/agent-event-runtime' packages/claxedo-app/src 2>/dev/null | grep -vE '\.test\.|\.vitest\.' | sort -u | wc -l | tr -d ' ')"
  say "importers.sdk_process-ownership" "$(grep -rl '@claxedo/process-ownership' $SDKS 2>/dev/null | grep -vE '\.test\.|test-utils|test-support' | sort -u | wc -l | tr -d ' ')"
  say "mutable.sites" "$(grep -rnE '^(export )?(let|var) [a-zA-Z]|^const [a-zA-Z_]+(: [^=]+)? = new (Map|Set|WeakMap).*\(\)' $SDKS $AER packages/agent-runtime-contract/src packages/opencode-server-adapter/src packages/process-ownership/src 2>/dev/null | grep -vE 'test|test-utils|test-support' | wc -l | tr -d ' ')"
  PLAN=docs/plans/2026-09-24-002-refactor-harness-rebuild-plan.md
  if [ -f "$PLAN" ]; then
    say "defect_rows" "$(grep -cE '^\| (H|C|T)-[0-9]+ \|' "$PLAN")"
    say "flow_rows" "$(grep -cE '^\| H[0-9]' "$PLAN")"
  fi
  say "harness_traces.files" "$(find packages/claxedo-app/e2e/fixtures/harness-traces -type f 2>/dev/null | wc -l | tr -d ' ')"
  say "app_e2e.spec_files" "$(find packages/claxedo-app -name '*.spec.ts' 2>/dev/null | wc -l | tr -d ' ')"
  say "app_e2e.specs_on_mock_runtime" "$(grep -rl 'mock-runtime' packages/claxedo-app/e2e --include='*.spec.ts' 2>/dev/null | wc -l | tr -d ' ')"
  say "sandbox.drivers" "$(grep -cE 'id: "' packages/sandbox-manager/src/driver-catalog.ts 2>/dev/null)"
  say "sandbox.broker_native" "$(grep -c 'secretBrokering: "native"' packages/sandbox-manager/src/driver-catalog.ts 2>/dev/null)"
  say "packages.claxedo_nonprivate" "$(grep -l '"private": *true' packages/*/package.json >/dev/null 2>&1; for pj in packages/*/package.json; do grep -q '"name": *"@claxedo/' "$pj" && ! grep -q '"private": *true' "$pj" && echo "$pj"; done | wc -l | tr -d ' ')"
}

# git-rev-dependent and contract measurements
revfix() { local rev="$1" pfx="$2"; cd "$REPO"
  local t=0 tt=0 f g
  for p in $PKGS; do f=$(git log $rev --format=%s -- "packages/$p/src" | grep -ci fix); g=$(git log $rev --format=%s -- "packages/$p/src" | wc -l | tr -d ' '); printf '%sfixes.%s %s/%s\n' "$pfx" "$p" "$f" "$g"; t=$((t+f)); tt=$((tt+g)); done
  printf '%sfixes.four_packages_sum %s/%s\n' "$pfx" "$t" "$tt"
  printf '%sfixes.four_packages_combined %s/%s\n' "$pfx" "$(git log $rev --format=%s -- packages/agent-sdk-runtime/src packages/agent-event-runtime/src packages/agent-runtime-contract/src packages/opencode-server-adapter/src | grep -ci fix)" "$(git log $rev --format=%s -- packages/agent-sdk-runtime/src packages/agent-event-runtime/src packages/agent-runtime-contract/src packages/opencode-server-adapter/src | wc -l | tr -d ' ')"
  printf '%sfixes.event.harnesses %s\n' "$pfx" "$(git log $rev --format=%s -- packages/agent-event-runtime/src/harnesses | grep -ci fix)/$(git log $rev --format=%s -- packages/agent-event-runtime/src/harnesses | wc -l | tr -d ' ')"
  printf '%sfixes.sdk.harnesses %s\n' "$pfx" "$(git log $rev --format=%s -- packages/agent-sdk-runtime/src/harnesses | grep -ci fix)/$(git log $rev --format=%s -- packages/agent-sdk-runtime/src/harnesses | wc -l | tr -d ' ')"
  printf '%sfixes.sdk.launch %s\n' "$pfx" "$(git log $rev --format=%s -- packages/agent-sdk-runtime/src/launch | grep -ci fix)/$(git log $rev --format=%s -- packages/agent-sdk-runtime/src/launch | wc -l | tr -d ' ')"
  printf '%sfixes.process-ownership %s\n' "$pfx" "$(git log $rev --format=%s -- packages/process-ownership/src | grep -ci fix)/$(git log $rev --format=%s -- packages/process-ownership/src | wc -l | tr -d ' ')"
}
members() { local root="$1" pfx="$2"
  AC="$root/packages/agent-sdk-runtime/src/adapter-contract.ts"
  DR="$root/packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-driver.ts"
  [ -f "$AC" ] && [ -f "$DR" ] && python3 "$SELF/_members.py" "$AC" "$DR" | awk -v p="$pfx" '/^TOTAL/{print p "contract.members", $2} /^ADDONS_IFACES/{print p "contract.addons", $2 "/" $4} /^CORE/{print p "contract.core", $2}' || echo "${pfx}contract.members MISSING"
}
if [ -d "$DEVTREE" ]; then
  measure "$DEVTREE" "dev."
  revfix "$DEVREV" "dev."
  members "$DEVTREE" "dev."
fi
measure "$REPO" "today."
revfix HEAD "today."
members "$REPO" "today."

# ratchet ceilings; dev via git show (script/ is not in _devtree)
ceil() { local pfx="$1" src="$2"; cd "$REPO"
  for pair in "local-server:local-server.ts" "server:server.ts" "desktop_main:desktop.ts"; do
    n=${pair%%:*}; f=${pair##*:}
    if [ "$src" = HEAD ]; then c=$(cat "script/product-boundary/policies/$f" 2>/dev/null); else c=$(git show "$src:script/product-boundary/policies/$f" 2>/dev/null); fi
    v=$(echo "$c" | grep -m1 -oE 'ceilings: \{ modules: [0-9]+, packages: [0-9]+ \}' | grep -oE '[0-9]+' | tr '\n' '/')
    printf '%sceiling.%s %s\n' "$pfx" "$n" "${v%/}"
  done
}
ceil "dev." "$DEVREV"
ceil "today." "HEAD"

resp_rows() { local pfx="$1" f="$2"; [ -f "$f" ] && printf '%sresp_table_rows %s\n' "$pfx" "$(sed -n '41,66p' "$f" | grep -cE '^\| [0-9]')" ; }
resp_rows "today." "$REPO/docs/plans/2026-09-24-002-refactor-harness-rebuild-plan.md"
resp_rows "dev." "$DEVTREE/docs/plans/2026-09-24-002-refactor-harness-rebuild-plan.md"
cd "$REPO"; printf 'today.permission_ceiling.lines %s\n' "$(wc -l < packages/agent-sdk-runtime/src/permission-ceiling.ts | tr -d ' ')"
printf 'dev.permission_ceiling.lines %s\n' "$(git show $DEVREV:packages/agent-sdk-runtime/src/permission-ceiling.ts 2>/dev/null | wc -l | tr -d ' ')"
o300=0; for p in $PKGS; do n=$(find packages/$p/src -name '*.ts' ! -name '*.test.ts' ! -path '*/test-utils/*' ! -path '*/test-support/*' ! -name 'test-temp-dir.ts' | xargs wc -l 2>/dev/null | awk '$1>300' | grep -vc total); o300=$((o300+n)); done
printf 'today.files_over_300.four_packages %s\n' "$o300"
