#!/usr/bin/env bash
# Run the core e2e suite as an N-way Playwright shard across separate crabbox boxes.
#
# One box does not scale: the suite is dominated by fixed per-test waits (poll
# intervals, SSE settle windows), not CPU, so 8x workers on a single box buys
# ~1.6x. Separate boxes are the only thing that divides wall-clock.
#
#   script/cbx-e2e-shard.sh fixe2e e2e2 e2e3 fixci -- --grep=slow
#
# Writes each shard's output to /tmp/e2e-shard-<slug>.log and prints a merged
# failure list. Extra playwright args go after a literal `--` separator and are
# forwarded as remote positional parameters; the E2E_ARGS env var is still
# accepted but splits on whitespace only. Args never enter the remote shell
# text, so quoting survives and shell metacharacters stay inert. Set
# E2E_SHARD_DRY_RUN=1 to print each shard's remote argv NUL-separated without
# executing it.
set -uo pipefail
cd "$(dirname "$0")/.."

BOXES=()
E2E_ARGS_ARRAY=()
forwarding=0
for arg in "$@"; do
  if ((forwarding)); then
    E2E_ARGS_ARRAY+=("$arg")
  elif [[ "$arg" == "--" ]]; then
    forwarding=1
  else
    BOXES+=("$arg")
  fi
done
if [[ -n "${E2E_ARGS:-}" ]]; then
  read -ra e2e_env_args <<<"$E2E_ARGS"
  E2E_ARGS_ARRAY+=(${e2e_env_args[@]+"${e2e_env_args[@]}"})
fi

N=${#BOXES[@]}
[ "$N" -eq 0 ] && { echo "usage: $0 <box-slug>... [-- <playwright args>...]" >&2; exit 2; }

# Slugs name the remote box (--id) and the local log file; restrict them so a
# mistyped or hostile value can neither traverse the output dir nor smuggle
# shell syntax into the remote argv.
for box in "${BOXES[@]}"; do
  if [[ ! "$box" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
    echo "invalid crabbox box slug: $box" >&2
    exit 2
  fi
done

OUT=${E2E_OUT_DIR:-/tmp/e2e-shards}
mkdir -p "$OUT"
rm -f "$OUT"/shard-*.log

# Env mirrors .github/workflows/test.yml's e2e job EXACTLY. Dropping any of
# it does not just lose coverage, it manufactures failures: without
# CLAXEDO_E2E_SERVE_MODE=build-preview, the dev server transforms on demand
# and every first navigation blows its expect timeout (the workflow records 188
# toBeVisible timeouts / 2.5h that way), and without VITE_CLAXEDO_E2E the
# bundle tree-shakes the test-auth seam so auth specs go anonymous.
#
# $1 is the shard spec and ${@:2} the forwarded playwright args: positional
# parameters keep every caller-controlled token out of this shell text. The
# script stays single-line so the dry-run record is one argv field per line.
REMOTE_SCRIPT='umask 022; cd packages/claxedo-app || exit 1;'
REMOTE_SCRIPT+=' CLAXEDO_E2E_SERVE_MODE=build-preview PLAYWRIGHT_VIDEO=0'
REMOTE_SCRIPT+=' VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001 VITE_CLAXEDO_E2E=1 CI=1'
REMOTE_SCRIPT+=' bun run test:e2e:core:base --'
REMOTE_SCRIPT+=' --workers=8 "--shard=$1" --reporter=list "${@:2}"'

DRY_RUN=${E2E_SHARD_DRY_RUN:-0}

for i in "${!BOXES[@]}"; do
  box=${BOXES[$i]}
  shard=$((i + 1))
  # ${arr[@]+...} keeps set -u happy on bash 3.2 (macOS orchestrators) when no
  # extra playwright args were given.
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s\0' ./script/cbx run --id "$box" --no-sync -- \
      bash -c "$REMOTE_SCRIPT" e2e-shard "$shard/$N" ${E2E_ARGS_ARRAY[@]+"${E2E_ARGS_ARRAY[@]}"}
    printf '\n'
    continue
  fi
  (
    ./script/cbx run --id "$box" --no-sync -- \
      bash -c "$REMOTE_SCRIPT" e2e-shard "$shard/$N" ${E2E_ARGS_ARRAY[@]+"${E2E_ARGS_ARRAY[@]}"} \
      > "$OUT/shard-$shard-$box.log" 2>&1
    echo "shard $shard/$N ($box) exited $?"
  ) &
done
wait

[[ "$DRY_RUN" == "1" ]] && exit 0

echo
echo "================ MERGED FAILURES ================"
grep -hE "^\s+[0-9]+\) |✘|Error:|expect\(" "$OUT"/shard-*.log | sed 's/^[[:space:]]*//' | sort -u
echo
echo "================ SHARD TOTALS ================"
grep -hE "^\s*[0-9]+ (passed|failed|flaky|skipped)|passed \(|failed \(" "$OUT"/shard-*.log
echo
echo "logs in $OUT"
