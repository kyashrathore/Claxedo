#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: repack.sh <worktree> <output-dir> [--renderer-only <base-packaged-dir>] [--expect <marker>]

  default          full Linux package of the worktree: build:packages, then
                   package:linux -- --dir --publish never (about 3.5 min)
  --renderer-only  rebuild only the renderer (packages/claxedo-app, packages/ui)
                   and swap it into a copy of <base-packaged-dir>'s app.asar;
                   valid only when main, preload and the server bundle are
                   unchanged from the commit that built the base
  --expect         fail unless <marker> occurs in the packaged renderer
USAGE
  exit 2
}

[ $# -ge 2 ] || usage
worktree=$(realpath "$1"); output=$(realpath -m "$2"); shift 2
base=""; marker=""
while [ $# -gt 0 ]; do
  case "$1" in
    --renderer-only) base=$(realpath "$2"); shift 2 ;;
    --expect) marker=$2; shift 2 ;;
    *) usage ;;
  esac
done

tools=$(dirname "$(realpath "$0")")/tools
export PATH=/home/user/tools/node_modules/.bin:$PATH
desktop=$worktree/packages/claxedo-desktop
started=$(date +%s)
cd "$worktree"
[ -d node_modules ] || bun install --frozen-lockfile
bun run build:packages

if [ -z "$base" ]; then
  bun run --cwd packages/claxedo-desktop package:linux -- --dir --publish never
  rm -rf "$output"
  mkdir -p "$(dirname "$output")"
  cp -a "$desktop/dist/linux-unpacked" "$output"
  mode=full
else
  [ -f "$base/resources/app.asar" ] || { echo "no packaged app at $base" >&2; exit 2; }
  rm -rf "$desktop/out/renderer"
  config=$desktop/.benchmark-renderer-only.config.ts
  cp "$tools/renderer-only.config.ts" "$config"
  trap 'rm -f "$config"' EXIT
  (cd "$desktop" && ./node_modules/.bin/electron-vite build -c "$config")
  rm -f "$config"
  rm -rf "$output"
  mkdir -p "$(dirname "$output")"
  cp -a --reflink=auto "$base" "$output"
  (cd "$tools" && node replace-renderer.mjs "$output/resources/app.asar" "$desktop/out/renderer")
  mode="renderer-only (base $base)"
fi

{
  echo "worktree: $worktree"
  echo "commit: $(git -C "$worktree" rev-parse HEAD)"
  echo "uncommitted: $(git -C "$worktree" status --porcelain --untracked-files=no | wc -l) files, diff sha256 $(git -C "$worktree" diff HEAD | sha256sum | cut -c1-16)"
  echo "mode: $mode"
  echo "built: $(date -u +%FT%TZ) in $(( $(date +%s) - started )) s"
} > "$output/benchmark-build.txt"

if [ -n "$marker" ]; then (cd "$tools" && node find-in-asar.mjs "$output/resources/app.asar" "$marker"); fi
cat "$output/benchmark-build.txt"
echo "executable: $output/claxedo"
