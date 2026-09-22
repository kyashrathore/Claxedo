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

# Digest verification uses constants pinned in this file. A sums file fetched
# from the same host as the archive would share the archive's trust domain, so
# a compromised mirror could ship a forged artifact plus a forged checksum.
verify_sha256() {
  local path=${1:?verify_sha256 requires a path}
  local expected=${2:?verify_sha256 requires a digest}
  local actual
  actual="$(sha256sum "$path" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA-256 mismatch for $path: expected $expected, got $actual" >&2
    return 1
  fi
}

ensure_node_version() {
  local version=${1:?ensure_node_version requires a version}
  local machine expected
  case "$(uname -m)" in
    x86_64) machine=x64 ;;
    aarch64 | arm64) machine=arm64 ;;
    *) echo "unsupported Node.js architecture: $(uname -m)" >&2; return 2 ;;
  esac
  case "$version/$machine" in
    v24.15.0/x64) expected=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6 ;;
    v24.15.0/arm64) expected=f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0 ;;
    v22.23.2/x64) expected=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307 ;;
    v22.23.2/arm64) expected=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8 ;;
    *) echo "no pinned SHA-256 for Node.js $version linux-$machine" >&2; return 2 ;;
  esac
  local archive="node-$version-linux-$machine.tar.xz"
  local cache="$HOME/.cache/claxedo-ci/node-$version-linux-$machine"
  if [[ ! -x "$cache/bin/node" ]]; then
    local download_dir="$HOME/.cache/claxedo-ci/downloads"
    mkdir -p "$download_dir" "$cache"
    curl --fail --location --silent --show-error \
      "https://nodejs.org/dist/$version/$archive" -o "$download_dir/$archive"
    verify_sha256 "$download_dir/$archive" "$expected"
    tar -xJf "$download_dir/$archive" --strip-components=1 -C "$cache"
  fi
  export PATH="$cache/bin:$PATH"
  [[ "$(node --version)" == "$version" ]]
}

ensure_node_24_15() {
  ensure_node_version v24.15.0
}

ensure_node_22_23() {
  ensure_node_version v22.23.2
}

ensure_bun_1_3_14() {
  local version=1.3.14
  if command -v bun >/dev/null 2>&1 && [[ "$(bun --version)" == "$version" ]]; then
    return
  fi

  # The release zip has no second trust domain to fetch a checksum from, so the
  # pinned digest covers the extracted binary. The values were cross-checked
  # against the integrity-verified @oven/bun-linux-* npm artifacts.
  local release_arch archive directory expected
  case "$(uname -m)" in
    x86_64)
      release_arch=x64-baseline
      expected=a8f9ebd1770ddc8e55dab7a68d4ec1ec1eebf374bb97cc65cf2c3cb373fc6791
      ;;
    aarch64 | arm64)
      release_arch=aarch64
      expected=37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086
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
    if ! verify_sha256 "$cache/$directory/bun" "$expected"; then
      rm -rf "$cache"
      return 1
    fi
    chmod 0755 "$cache/$directory/bun"
  fi
  export PATH="$cache/$directory:$PATH"
  [[ "$(bun --version)" == "$version" ]]
}

ensure_synced_source_repository() {
  # Crabbox can sync only the working tree. Some real product and build paths
  # call git, so create a single-commit repository whose tree is exactly the
  # synced source whenever the transport did not preserve Git metadata. Run
  # this after dependency installation so patches are applied outside an
  # incomplete synthetic object database.
  if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
    git init -q -b dev .
    git config user.email "crabbox@claxedo.test"
    git config user.name "Crabbox CI"
    git config commit.gpgsign false
    git add -A
    git commit -q -m "Crabbox synced source"
  fi
}

ensure_rust_target() {
  local target=${1:?ensure_rust_target requires a target triple}
  # rustup-init comes from the versioned archive tree: the unversioned dist/
  # path is replaced on every rustup release, which would orphan a pinned
  # digest and silently change what CI executes.
  local rustup_version=1.28.2
  local host expected
  case "$(uname -m)" in
    x86_64)
      host=x86_64-unknown-linux-gnu
      expected=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
      ;;
    aarch64 | arm64)
      host=aarch64-unknown-linux-gnu
      expected=e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c
      ;;
    *) echo "unsupported Rust architecture: $(uname -m)" >&2; return 2 ;;
  esac

  export RUSTUP_HOME="$HOME/.cache/claxedo-ci/rustup"
  export CARGO_HOME="$HOME/.cache/claxedo-ci/cargo"
  export PATH="$CARGO_HOME/bin:$PATH"
  if [[ ! -x "$CARGO_HOME/bin/rustup" ]]; then
    local installer="$HOME/.cache/claxedo-ci/downloads/rustup-init-$rustup_version-$host"
    mkdir -p "$(dirname "$installer")" "$RUSTUP_HOME" "$CARGO_HOME"
    curl --fail --location --silent --show-error \
      "https://static.rust-lang.org/rustup/archive/$rustup_version/$host/rustup-init" -o "$installer"
    verify_sha256 "$installer" "$expected"
    chmod 0755 "$installer"
    "$installer" -y --no-modify-path --profile minimal --default-toolchain stable
  fi
  rustup toolchain install stable --profile minimal
  rustup target add --toolchain stable "$target"
  cargo --version
}

install_root() {
  ensure_node_24_15
  ensure_bun_1_3_14
  bun install --frozen-lockfile
  ensure_synced_source_repository
}

build_dist_packages() {
  bun run build:packages
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
    libasound2t64 \
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
  # Exact pins keep lanes off a moving @latest target. npm still verifies the
  # tarball against registry integrity, and env -i keeps freshly downloaded
  # package lifecycle scripts (claude-code's postinstall materializes the
  # native binary) away from lane credentials.
  local claude_code_version=2.1.278
  local codex_version=0.155.1
  local prefix="$HOME/.cache/claxedo-ci/harness-clis"
  mkdir -p "$prefix"
  env -i HOME="$HOME" PATH="$PATH" \
    npm install --prefix "$prefix" --no-fund --no-audit \
    "@anthropic-ai/claude-code@$claude_code_version" "@openai/codex@$codex_version"
  export PATH="$prefix/node_modules/.bin:$PATH"
}

run_diagnostics() {
  install_linux_gui_dependencies
  install_root
  install_app_server_native_dependencies
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
  (cd packages/claxedo-app && bun run build && bun run verify:closure)
  install_chromium
  (
    cd packages/claxedo-app/perf-harness
    CLAXEDO_PERF_APP_SCRIPT=serve bun run ci:diagnostics
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

run_release_gates_linux_x64() {
  install_linux_gui_dependencies
  install_linux_native_build_dependencies
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb
  ensure_node_22_23
  ensure_bun_1_3_14
  ensure_rust_target x86_64-unknown-linux-gnu
  bun install --frozen-lockfile --minimum-release-age=0
  ensure_synced_source_repository
  build_dist_packages
  (
    cd packages/claxedo-desktop
    CLAXEDO_CHANNEL=prod \
    RUST_TARGET=x86_64-unknown-linux-gnu \
    VITE_CLAXEDO_HOSTED_ACTIVATION=true \
      bun run build
  )
  (
    cd packages/claxedo-desktop
    mkdir -p .artifacts
    CLAXEDO_DIAGNOSTICS_SMOKE_OUTPUT=.artifacts/diagnostics-source-x86_64-unknown-linux-gnu.json \
    CLAXEDO_DIAGNOSTICS_EXPECTED_ARCH=x64 \
    CLAXEDO_DIAGNOSTICS_DEBUG=1 \
      bun run test:diagnostics-release
    CLAXEDO_DIAGNOSTICS_SMOKE_OUTPUT=.artifacts/diagnostics-source-x86_64-unknown-linux-gnu.json \
    CLAXEDO_DIAGNOSTICS_EXPECTED_ARCH=x64 \
    CLAXEDO_DIAGNOSTICS_DEBUG=1 \
      bun run smoke:diagnostics
  )
  (cd packages/claxedo-app && bun run test:diagnostics-release)
  (
    cd packages/claxedo-desktop
    CLAXEDO_CHANNEL=prod \
    RUST_TARGET=x86_64-unknown-linux-gnu \
    CSC_IDENTITY_AUTO_DISCOVERY=false \
      bun run package:linux -- --x64 --dir --publish never
    CLAXEDO_DIAGNOSTICS_SMOKE_OUTPUT=.artifacts/diagnostics-packaged-x86_64-unknown-linux-gnu.json \
    CLAXEDO_DIAGNOSTICS_EXPECTED_ARCH=x64 \
      xvfb-run -a bun run smoke:diagnostics:packaged
  )
}

run_unit() {
  install_linux_gui_dependencies
  install_root
  install_app_server_native_dependencies
  (cd packages/claxedo-app/perf-harness && bun install --frozen-lockfile)
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

# Native descriptor and symlink semantics; diagnostic subset of unit-linux.
run_workspace_files() {
  install_root
  (
    cd packages/workspace-runtime
    bun test src/workspace-files/working-tree.test.ts src/routes/diff.test.ts src/target.test.ts
  )
}

run_typecheck() {
  install_root
  build_dist_packages
  (cd packages/claxedo-app/perf-harness && bun install --frozen-lockfile)
  bun run lint
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
  # The forced filtered install replaces shared package contents after the
  # root postinstall has applied the repository-owned dependency patches.
  # Restore those canonical patched surfaces before any package-local child
  # or test can load the newly materialized dependency graph.
  bun script/apply-dependency-patches.ts
  test -e packages/claxedo-server/node_modules/better-sqlite3
  test -e packages/claxedo-server-core/node_modules/better-sqlite3
}

run_e2e_core() {
  local shard=${1:?e2e-core requires a shard number}
  local total=${2:?e2e-core requires a shard count}
  if [[ ! "$shard" =~ ^[0-9]+$ || ! "$total" =~ ^[0-9]+$ || shard -lt 1 || shard -gt total ]]; then
    echo "e2e-core requires numeric shard index/count within 1..N (got '$shard/$total')" >&2
    return 2
  fi
  prepare_e2e
  # Core discovery imports server-side harness modules even when their tagged
  # tests are excluded. Materialize the app/server native dependency graph
  # before Playwright loads those modules; a root-only Bun install does not
  # expose better-sqlite3 from a fresh generic AWS image.
  install_app_server_native_dependencies
  (
    cd packages/claxedo-app
    CLAXEDO_E2E_SERVE_MODE=build-preview \
    PLAYWRIGHT_VIDEO=0 \
    VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001 \
    VITE_CLAXEDO_E2E=1 \
      bun run test:e2e:core:base -- --shard="$shard/$total"
  )
}

run_e2e_onboarding() {
  prepare_e2e
  install_app_server_native_dependencies
  (
    cd packages/claxedo-app
    CLAXEDO_E2E_SERVE_MODE=build-preview \
    PLAYWRIGHT_VIDEO=0 \
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
  install_chromium
}

run_e2e_tier_real_scenario() {
  local scenario="${1:?tier-real scenario grep is required}"
  prepare_e2e_tier_real
  (
    cd packages/claxedo-app
    VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:4317 bun run build:e2e
    CLAXEDO_E2E_SERVE_MODE=preview PLAYWRIGHT_VIDEO=0 \
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
        e2e/playwright/web-signed-host-tunnel.spec.ts \
        e2e/playwright/web-signed-org-team-multiplayer.spec.ts \
        --workers=1
  )
}

run_e2e_tier_real_web_target() {
  local spec=${1:?signed web spec is required}
  local scenario=${2:?signed web scenario grep is required}
  if [[ "$spec" != e2e/playwright/*.spec.ts || "$spec" == *..* ]]; then
    echo "e2e-tier-real-web-target spec must be e2e/playwright/*.spec.ts (got '$spec')" >&2
    return 2
  fi
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
    VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:4317 bun run build:e2e
    for scenario in \
      "pi-workspace harness completes exact turns|local new-worktree session receives its first reply" \
      "claude native SDK harness completes exact turns" \
      "codex native SDK harness completes exact turns" \
      "cursor harness materializes without silently routing"; do
      CLAXEDO_E2E_SERVE_MODE=preview PLAYWRIGHT_VIDEO=0 \
        bun run test:e2e:real -- --grep "$scenario"
    done
    CLAXEDO_E2E_SUITE=core \
    CLAXEDO_TIER_REAL_E2E=1 \
    PLAYWRIGHT_SKIP_WEBSERVER=1 \
    PLAYWRIGHT_VIDEO=0 \
      npx playwright test \
        --config playwright.config.ts \
        e2e/playwright/web-signed-cloud.spec.ts \
        e2e/playwright/web-signed-host-tunnel.spec.ts \
        e2e/playwright/web-signed-org-team-multiplayer.spec.ts \
        --workers=1
  )
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
  release-gates-linux-x64) run_release_gates_linux_x64 ;;
  unit-linux) run_unit ;;
  workspace-files-linux) run_workspace_files ;;
  typecheck-linux) run_typecheck ;;
  e2e-core) run_e2e_core "$@" ;;
  e2e-onboarding) run_e2e_onboarding ;;
  e2e-tier-real) run_e2e_tier_real ;;
  e2e-tier-real-scenario) run_e2e_tier_real_scenario "$@" ;;
  e2e-tier-real-web) run_e2e_tier_real_web ;;
  e2e-tier-real-web-target) run_e2e_tier_real_web_target "$@" ;;
  packages-dry-run) run_packages_dry_run ;;
  relay-bench) run_relay_bench ;;
  storybook) run_storybook ;;
  *)
    echo "unknown Crabbox CI lane: $LANE" >&2
    exit 2
    ;;
esac
