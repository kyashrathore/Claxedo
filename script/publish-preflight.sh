#!/usr/bin/env bash
# Publish preflight for the Claxedo package release.
#
# For every package this builds it, packs it with `npm pack`, then fails
# loudly if any of the following is true of the packed tarball:
#
#   1. The packed package.json's dependencies/peerDependencies/
#      optionalDependencies still contain a `workspace:` or `catalog:`
#      specifier. `npm pack`/`npm publish` do NOT rewrite these (only
#      `bun publish` does) — this is exactly what broke @claxedo/mcp's
#      unrewritten `"workspace:0.1.0"` first-party dependency: it packed
#      fine, then downstream `npm install` failed with
#      EUNSUPPORTEDPROTOCOL.
#   2. The local version is already the version live on npm (`npm view
#      <name> version`) — meaning this package's version bump is missing.
#      A package that has never been published (npm view 404s) passes
#      this check instead of failing it — @claxedo/wakes is expected to
#      hit this path until its first publish.
#   3. The tarball is missing README.md or LICENSE.
#
# Usage:
#   script/publish-preflight.sh                  # check the 12 release packages
#   script/publish-preflight.sh wakes mcp         # check a subset (packages/<dir> names)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$ROOT/packages"

DEFAULT_PACKAGES=(
  agent-event-runtime
  agent-extensions
  agent-sdk-runtime
  sandbox-contract
  sandbox-manager
  workspace-relay
  workspace-relay-protocol
  workspace-runtime
  claxedo-mcp
  claxedo-channels
  claxedo-connections
  wakes
)

if [ "$#" -gt 0 ]; then
  PACKAGES=("$@")
else
  PACKAGES=("${DEFAULT_PACKAGES[@]}")
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/claxedo-publish-preflight.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

RESULT_NAMES=()
RESULT_STATUSES=()
RESULT_REASONS=()
FAIL_COUNT=0

log_step() {
  printf '    %-38s %s\n' "$1" "$2"
}

# Prints "section.dep=spec" for every dependency/peerDependency/
# optionalDependency whose value still contains a workspace: or catalog:
# specifier. Prints nothing and exits 0 when the package.json is clean.
check_specifiers_json() {
  node -e '
    const fs = require("node:fs")
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const sections = ["dependencies", "peerDependencies", "optionalDependencies"]
    const bad = []
    for (const section of sections) {
      const deps = pkg[section]
      if (!deps) continue
      for (const [dep, spec] of Object.entries(deps)) {
        if (typeof spec === "string" && (spec.includes("workspace:") || spec.includes("catalog:"))) {
          bad.push(section + "." + dep + "=" + spec)
        }
      }
    }
    process.stdout.write(bad.join("\n"))
  ' "$1"
}

# Exits 0 if the given path (e.g. "README.md") is present in the tarball
# described by an `npm pack --json` metadata file, 1 otherwise.
pack_has_file() {
  node -e '
    const fs = require("node:fs")
    const meta = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const files = meta[0].files.map((f) => f.path)
    process.exit(files.includes(process.argv[2]) ? 0 : 1)
  ' "$1" "$2"
}

record_result() {
  RESULT_NAMES+=("$1")
  RESULT_STATUSES+=("$2")
  RESULT_REASONS+=("$3")
  if [ "$2" = "FAIL" ]; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

for dir_name in "${PACKAGES[@]}"; do
  pkg_dir="$PKG_DIR/$dir_name"
  echo "==> $dir_name"

  if [ ! -f "$pkg_dir/package.json" ]; then
    log_step "package.json" "FAIL (not found at packages/$dir_name)"
    record_result "$dir_name" "FAIL" "missing package.json"
    echo
    continue
  fi

  pkg_name="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).name)' "$pkg_dir/package.json")"
  pkg_version="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$pkg_dir/package.json")"

  status="PASS"
  reasons=()
  work="$WORKDIR/$dir_name"
  mkdir -p "$work"

  # 1. build
  if (cd "$pkg_dir" && npm run build) >"$work/build.log" 2>&1; then
    log_step "build" "ok"
  else
    log_step "build" "FAIL (see $work/build.log)"
    record_result "$pkg_name" "FAIL" "build failed"
    echo
    continue
  fi

  # 2. pack
  if (cd "$pkg_dir" && npm pack --json --pack-destination "$work") >"$work/pack.json" 2>"$work/pack.err.log"; then
    tgz="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))[0].filename)' "$work/pack.json")"
    log_step "pack" "ok ($tgz)"
  else
    log_step "pack" "FAIL (see $work/pack.err.log)"
    record_result "$pkg_name" "FAIL" "npm pack failed"
    echo
    continue
  fi

  mkdir -p "$work/extract"
  tar -xzf "$work/$tgz" -C "$work/extract"

  # 3. workspace:/catalog: specifiers in the packed package.json
  bad_specs="$(check_specifiers_json "$work/extract/package/package.json")"
  if [ -z "$bad_specs" ]; then
    log_step "workspace:/catalog: specifiers" "ok"
  else
    log_step "workspace:/catalog: specifiers" "FAIL"
    while IFS= read -r line; do
      [ -n "$line" ] && printf '        %s\n' "$line"
    done <<<"$bad_specs"
    status="FAIL"
    reasons+=("unrewritten workspace:/catalog: dependency")
  fi

  # 4. version vs npm
  npm_version="$(npm view "$pkg_name" version 2>"$work/npm-view.err.log")"
  npm_view_rc=$?
  if [ $npm_view_rc -ne 0 ]; then
    if grep -q "E404" "$work/npm-view.err.log"; then
      log_step "version vs npm" "ok ($pkg_name not yet published)"
    else
      log_step "version vs npm" "FAIL (npm view error, see $work/npm-view.err.log)"
      status="FAIL"
      reasons+=("npm view failed")
    fi
  elif [ "$npm_version" = "$pkg_version" ]; then
    log_step "version vs npm" "FAIL (local $pkg_version == published $npm_version; bump missing)"
    status="FAIL"
    reasons+=("version bump missing ($pkg_version already on npm)")
  else
    log_step "version vs npm" "ok (local $pkg_version, published $npm_version)"
  fi

  # 5. README.md / LICENSE present in the tarball
  missing_files=()
  for f in README.md LICENSE; do
    if ! pack_has_file "$work/pack.json" "$f"; then
      missing_files+=("$f")
    fi
  done
  if [ "${#missing_files[@]}" -eq 0 ]; then
    log_step "README.md/LICENSE in tarball" "ok"
  else
    log_step "README.md/LICENSE in tarball" "FAIL (missing: ${missing_files[*]:-})"
    status="FAIL"
    reasons+=("tarball missing: ${missing_files[*]:-}")
  fi

  echo "    RESULT: $status"
  echo

  record_result "$pkg_name" "$status" "${reasons[*]:-}"
done

echo "================ SUMMARY ================"
pass_count=0
total=${#RESULT_NAMES[@]}
for i in "${!RESULT_NAMES[@]}"; do
  if [ "${RESULT_STATUSES[$i]}" = "PASS" ]; then
    pass_count=$((pass_count + 1))
    printf 'PASS  %s\n' "${RESULT_NAMES[$i]}"
  else
    printf 'FAIL  %-38s %s\n' "${RESULT_NAMES[$i]}" "${RESULT_REASONS[$i]}"
  fi
done
echo "==========================================="
echo "$total package(s) checked: $pass_count PASS, $FAIL_COUNT FAIL"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
