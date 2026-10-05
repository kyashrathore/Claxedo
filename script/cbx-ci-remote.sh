#!/usr/bin/env bash
# Canonical remote implementation for Linux Crabbox CI jobs in .crabbox.yaml.
# Keep lane commands aligned with .github/workflows/test.yml and typecheck.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LANE=${1:?usage: cbx-ci-remote.sh <lane> [lane arguments...]}
shift

export CI=true

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

install_linux_gui_dependencies() {
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    libasound2t64 \
    libnotify-dev \
    libxtst-dev \
    libnss3-dev \
    libgdk-pixbuf2.0-dev \
    libgtk-3-dev \
    libxss-dev \
    xvfb \
    xauth
}

install_linux_native_build_dependencies() {
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    python3-setuptools
}

run_release_gates_linux_x64() {
  install_linux_gui_dependencies
  install_linux_native_build_dependencies
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
    CLAXEDO_CHANNEL=prod \
    RUST_TARGET=x86_64-unknown-linux-gnu \
    CSC_IDENTITY_AUTO_DISCOVERY=false \
      bun run package:linux -- --x64 --dir --publish never
  )
}

run_unit() {
  bash script/ci-linux-test-host.sh
  install_linux_gui_dependencies
  install_root
  install_app_server_native_dependencies
  git config --global user.email "github-actions[bot]@users.noreply.github.com"
  git config --global user.name "github-actions[bot]"
  bun run docs:check-links
  build_dist_packages
  bun run --cwd packages/claxedo-local-server verify:closure
  bun run --cwd packages/claxedo-host-connector verify:closure
  bun run --cwd packages/claxedo-server verify:closure
  bun run --cwd packages/claxedo-desktop verify:closure
  bun turbo test --concurrency=2 --continue
}

# Native descriptor and symlink semantics; diagnostic subset of unit-linux.
run_workspace_files() {
  install_root
  (
    cd packages/workspace-runtime
    bun run test:files src/workspace-files/working-tree.test.ts src/routes/diff.test.ts src/target.test.ts
  )
}

run_codex_conformance() {
  bash script/ci-linux-test-host.sh
  install_root
  build_dist_packages
  (
    cd packages/harness
    bun run test:files src/conformance/codex.test.ts
  )
}

run_typecheck() {
  install_root
  build_dist_packages
  bun run lint
  bun typecheck
}

install_app_server_native_dependencies() {
  # The unit lane spawns package-local child processes. Rebuild the
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

run_packages_dry_run() {
  install_root
  bun run build:packages
  (
    cd packages/claxedo-server
    node ./node_modules/vitest/vitest.mjs run scripts/release/tests
    bun run release:packages --track all --dry-run
  )
}

case "$LANE" in
  release-gates-linux-x64) run_release_gates_linux_x64 ;;
  unit-linux) run_unit ;;
  workspace-files-linux) run_workspace_files ;;
  codex-conformance) run_codex_conformance ;;
  typecheck-linux) run_typecheck ;;
  packages-dry-run) run_packages_dry_run ;;
  *)
    echo "unknown Crabbox CI lane: $LANE" >&2
    exit 2
    ;;
esac
