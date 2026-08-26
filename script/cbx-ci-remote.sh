#!/usr/bin/env bash
# Canonical remote implementation for Linux Crabbox CI jobs in .crabbox.yaml.
# Keep lane commands aligned with .github/workflows/test.yml and typecheck.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LANE=${1:?usage: cbx-ci-remote.sh <lane> [lane arguments...]}
shift

export CI=true
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/claxedo-playwright}"

ensure_node_24_15() {
  local version=v24.15.0
  local machine
  case "$(uname -m)" in
    x86_64) machine=x64 ;;
    aarch64 | arm64) machine=arm64 ;;
    *) echo "unsupported Node.js architecture: $(uname -m)" >&2; return 2 ;;
  esac
  local archive="node-$version-linux-$machine.tar.xz"
  local cache="$HOME/.cache/claxedo-ci/node-$version-linux-$machine"
  if [[ ! -x "$cache/bin/node" ]]; then
    local download_dir="$HOME/.cache/claxedo-ci/downloads"
    mkdir -p "$download_dir" "$cache"
    curl --fail --location --silent --show-error \
      "https://nodejs.org/dist/$version/$archive" -o "$download_dir/$archive"
    curl --fail --location --silent --show-error \
      "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
    (
      cd "$download_dir"
      grep "  $archive\$" SHASUMS256.txt | sha256sum --check -
    )
    tar -xJf "$download_dir/$archive" --strip-components=1 -C "$cache"
  fi
  export PATH="$cache/bin:$PATH"
  [[ "$(node --version)" == "$version" ]]
}

ensure_bun_1_3_14() {
  local version=1.3.14
  if command -v bun >/dev/null 2>&1 && [[ "$(bun --version)" == "$version" ]]; then
    return
  fi

  local release_arch archive directory
  case "$(uname -m)" in
    x86_64)
      release_arch=x64-baseline
      ;;
    aarch64 | arm64)
      release_arch=aarch64
      ;;
    *) echo "unsupported Bun architecture: $(uname -m)" >&2; return 2 ;;
  esac
  archive="bun-linux-$release_arch.zip"
  directory="bun-linux-$release_arch"
  local cache="$HOME/.cache/claxedo-ci/bun-v$version"
  if [[ ! -x "$cache/$directory/bun" ]]; then
    local download_dir="$HOME/.cache/claxedo-ci/downloads"
    mkdir -p "$download_dir" "$cache"
    curl --fail --location --silent --show-error \
      "https://github.com/oven-sh/bun/releases/download/bun-v$version/$archive" \
      -o "$download_dir/$archive"
    python3 -m zipfile -e "$download_dir/$archive" "$cache"
    chmod 0755 "$cache/$directory/bun"
  fi
  export PATH="$cache/$directory:$PATH"
  [[ "$(bun --version)" == "$version" ]]
}

install_root() {
  ensure_node_24_15
  ensure_bun_1_3_14
  bun install --frozen-lockfile

  # Crabbox syncs the working tree, not .git. Some real WorkGraph and unit
  # paths call git, so create a single-commit repository whose tree is exactly
  # the synced source. Do this after install so dependency patches are applied
  # outside an incomplete synthetic object database.
  if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
    git init -q -b dev .
    git config user.email "crabbox@claxedo.test"
    git config user.name "Crabbox CI"
    git config commit.gpgsign false
    git add -A
    git commit -q -m "Crabbox synced source"
  fi
}

build_dist_packages() {
  bun turbo build \
    --filter=@claxedo/agent-event-runtime \
    --filter=@claxedo/agent-extensions \
    --filter=@claxedo/agent-sdk-runtime \
    --filter=@claxedo/channels \
    --filter=@claxedo/connections \
    --filter=@claxedo/mcp \
    --filter=@claxedo/sandbox-contract \
    --filter=@claxedo/sandbox-manager \
    --filter=@claxedo/wakes \
    --filter=@claxedo/workgraph \
    --filter=@claxedo/workspace-relay-protocol \
    --filter=@claxedo/workspace-relay \
    --filter=@claxedo/workspace-runtime
}

install_chromium() {
  (
    cd packages/claxedo-app
    ./node_modules/.bin/playwright install --with-deps chromium
  )
}

install_linux_gui_dependencies() {
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    libnotify-dev \
    libxtst-dev \
    libnss3-dev \
    libgdk-pixbuf2.0-dev \
    libgtk-3-dev \
    libxss-dev
}

install_linux_native_build_dependencies() {
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    python3-setuptools
}

install_harness_clis() {
  local prefix="$HOME/.cache/claxedo-ci/harness-clis"
  mkdir -p "$prefix"
  npm install --prefix "$prefix" --no-fund --no-audit \
    @anthropic-ai/claude-code @openai/codex
  export PATH="$prefix/node_modules/.bin:$PATH"
}

run_diagnostics() {
  install_linux_gui_dependencies
  install_root
  (cd packages/claxedo-app/perf-harness && bun install --frozen-lockfile)
  build_dist_packages
  (
    cd packages/claxedo-desktop
    bun run build
    CLAXEDO_DIAGNOSTICS_VERIFY_ADVISORIES=1 bun run verify:diagnostics-dependencies
    bun run verify:diagnostics-privacy
    bun run test:diagnostics-release
  )
  (cd packages/claxedo-app && bun run test:diagnostics-release)
  (cd packages/claxedo-app/perf-harness && bun test)
  (cd packages/claxedo-app && bun run build && bun run verify:closure)
  install_chromium
  (
    cd packages/claxedo-app/perf-harness
    CLAXEDO_PERF_APP_SCRIPT=serve CLAXEDO_PERF_HEADROOM=1.0 bun run run:all
  )
  (
    cd packages/claxedo-desktop
    mkdir -p .artifacts
    ulimit -n "$(ulimit -Hn)" || true
    CLAXEDO_DIAGNOSTICS_SMOKE_OUTPUT=.artifacts/diagnostics-source-linux.json \
      bun run smoke:diagnostics
    test -s .artifacts/diagnostics-source-linux.json
  )
}

run_unit() {
  install_linux_gui_dependencies
  install_root
  install_app_server_native_dependencies
  git config --global user.email "github-actions[bot]@users.noreply.github.com"
  git config --global user.name "github-actions[bot]"
  bun run docs:check-links
  install_chromium
  (cd packages/session-ui && bun run verify:mermaid)
  build_dist_packages
  bun run --cwd packages/claxedo-local-server verify:closure
  bun run --cwd packages/claxedo-host-connector verify:closure
  bun run --cwd packages/claxedo-server verify:closure
  bun run --cwd packages/claxedo-desktop verify:closure
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=false bun turbo test --concurrency=2
}

run_typecheck() {
  install_root
  build_dist_packages
  bun typecheck
}

prepare_e2e() {
  install_root
  build_dist_packages
  install_chromium
}

install_app_server_native_dependencies() {
  # Unit and real E2E lanes spawn package-local child processes. Rebuild the
  # canonical isolated workspace links after a fresh AWS sync so those children
  # resolve the native better-sqlite3 owner from server-core. A hoisted install
  # leaves Bun's existing package-local links pointing at a removed .bun target.
  install_linux_native_build_dependencies
  bun install --frozen-lockfile --force \
    --filter @claxedo/app \
    --filter @claxedo/server \
    --filter @claxedo/server-core
  test -e packages/claxedo-server/node_modules/better-sqlite3
  test -e packages/claxedo-server-core/node_modules/better-sqlite3
}

run_e2e_core() {
  local shard=${1:?e2e-core requires a shard number}
  local total=${2:?e2e-core requires a shard count}
  prepare_e2e
  # Core discovery imports the shared real-WorkGraph harness even when its
  # tagged tests are excluded. Materialize the app/server native dependency
  # graph before Playwright loads those modules; a root-only Bun install does
  # not expose better-sqlite3 from a fresh generic AWS image.
  install_app_server_native_dependencies
  (
    cd packages/claxedo-app
    CLAXEDO_E2E_PREBUILT=1 \
    PLAYWRIGHT_VIDEO=0 \
    VITE_AUTH_ENABLED=true \
    VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001 \
    VITE_CLAXEDO_E2E=1 \
      bun run test:e2e:core:base -- --shard="$shard/$total"
  )
}

run_e2e_workgraph() {
  prepare_e2e
  install_app_server_native_dependencies
  (
    cd packages/claxedo-app
    CLAXEDO_E2E_PREBUILT=1 bun run test:e2e:workgraph
    CLAXEDO_E2E_PREBUILT=1 \
    PLAYWRIGHT_VIDEO=0 \
    VITE_AUTH_ENABLED=true \
    VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001 \
    VITE_CLAXEDO_E2E=1 \
      bun run test:e2e:onboarding
  )
}

prepare_e2e_tier_real() {
  install_root
  install_app_server_native_dependencies
  install_harness_clis
  build_dist_packages
  (cd packages/opencode && bun run build:node)
  install_chromium
}

run_e2e_tier_real_scenario() {
  local scenario="${1:?tier-real scenario grep is required}"
  prepare_e2e_tier_real
  (
    cd packages/claxedo-app
    CLAXEDO_E2E_PREBUILT=1 PLAYWRIGHT_VIDEO=0 \
      bun run test:e2e:real -- --grep "$scenario"
  )
}

run_e2e_tier_real_web() {
  prepare_e2e_tier_real
  (
    cd packages/claxedo-app
    CLAXEDO_E2E_SUITE=core \
    CLAXEDO_TIER_REAL_E2E=1 \
    PLAYWRIGHT_SKIP_WEBSERVER=1 \
    PLAYWRIGHT_VIDEO=0 \
      npx playwright test \
        --config playwright.config.ts \
        e2e/playwright/web-signed-cloud.spec.ts \
        e2e/playwright/web-signed-userhosted.spec.ts \
        --workers=1
  )
}

run_e2e_tier_real_web_target() {
  local spec=${1:?signed web spec is required}
  local scenario=${2:?signed web scenario grep is required}
  prepare_e2e_tier_real
  (
    cd packages/claxedo-app
    CLAXEDO_E2E_SUITE=core \
    CLAXEDO_TIER_REAL_E2E=1 \
    PLAYWRIGHT_SKIP_WEBSERVER=1 \
    PLAYWRIGHT_VIDEO=0 \
      npx playwright test \
        --config playwright.config.ts \
        "$spec" \
        --grep "$scenario" \
        --workers=1
  )
}

run_e2e_tier_real() {
  prepare_e2e_tier_real
  (
    cd packages/claxedo-app
    for scenario in \
      "behaviors 1,6,9" \
      "behaviors 2,6,8,9" \
      "behaviors 3,6,8,9" \
      "behaviors 4,6,8,9" \
      "behaviors 5,6,8,9" \
      "behavior 7"; do
      CLAXEDO_E2E_PREBUILT=1 PLAYWRIGHT_VIDEO=0 \
        bun run test:e2e:real -- --grep "$scenario"
    done
    CLAXEDO_E2E_SUITE=core \
    CLAXEDO_TIER_REAL_E2E=1 \
    PLAYWRIGHT_SKIP_WEBSERVER=1 \
    PLAYWRIGHT_VIDEO=0 \
      npx playwright test \
        --config playwright.config.ts \
        e2e/playwright/web-signed-cloud.spec.ts \
        e2e/playwright/web-signed-userhosted.spec.ts \
        --workers=1
  )
}

run_e2e_workgraph_journey() {
  install_root
  build_dist_packages
  (cd packages/claxedo-app && bun run test:e2e:journey)
}

run_agent_runtime_stats() {
  # The dedicated workflow intentionally tests this dependency-free package on
  # Node 22. The pinned Crabbox Linux image supplies Node 22 before install_root
  # prepends the Node 24 e2e toolchain, so keep this lane independent.
  [[ "$(node --version)" == v22.* ]]
  (
    cd packages/agent-runtime-stats
    npm test
    node bin/agent-runtime-stats.js --version
    npm pack --dry-run
  )
  bun install --frozen-lockfile --filter @claxedo/agent-runtime-stats
  (cd packages/agent-runtime-stats && bun run worker:check)
}

run_docs_links() {
  install_root
  (cd packages/claxedo-docs && bun run broken-links)
}

run_packages_dry_run() {
  install_root
  (
    cd packages/claxedo-server
    node ./node_modules/vitest/vitest.mjs run \
      scripts/release/tests/publish-claxedo-packages.test.ts \
      scripts/release/tests/publish-runtime-packages.test.ts
    bun run release:packages --track others --dry-run
  )
}

run_relay_bench() {
  install_root
  bun run --cwd packages/workspace-relay-protocol build
  bun run --cwd packages/sandbox-contract build
  bun run --cwd packages/sandbox-manager build
  (
    cd packages/workspace-relay
    bun run typecheck:bench
    bun run test
    CLAXEDO_BENCH_HTTP_P99_GATE_MS=250 bun run bench:gate
  )
}

run_storybook() {
  install_root
  bun --cwd packages/storybook build
}

case "$LANE" in
  diagnostics-linux) run_diagnostics ;;
  unit-linux) run_unit ;;
  typecheck-linux) run_typecheck ;;
  e2e-core) run_e2e_core "$@" ;;
  e2e-workgraph) run_e2e_workgraph ;;
  e2e-tier-real) run_e2e_tier_real ;;
  e2e-tier-real-scenario) run_e2e_tier_real_scenario "$@" ;;
  e2e-tier-real-web) run_e2e_tier_real_web ;;
  e2e-tier-real-web-target) run_e2e_tier_real_web_target "$@" ;;
  e2e-workgraph-journey) run_e2e_workgraph_journey ;;
  agent-runtime-stats) run_agent_runtime_stats ;;
  docs-links) run_docs_links ;;
  packages-dry-run) run_packages_dry_run ;;
  relay-bench) run_relay_bench ;;
  storybook) run_storybook ;;
  *)
    echo "unknown Crabbox CI lane: $LANE" >&2
    exit 2
    ;;
esac
