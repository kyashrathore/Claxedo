#!/bin/sh
# Installs the claxedo command for the current user, with no sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/kyashrathore/Claxedo/dev/packages/cli/install.sh | sh
#
# Environment:
#   CLAXEDO_CLI_VERSION   npm version or dist-tag to install (default: latest)
#   CLAXEDO_CLI_TARBALL   one or more local .tgz paths, space-separated; installed
#                         instead of the registry package (a release-check seam)
#   CLAXEDO_INSTALL_DIR   where a private Node and npm prefix go (default: ~/.claxedo)
set -eu

NODE_MAJOR=24
CLAXEDO_INSTALL_DIR="${CLAXEDO_INSTALL_DIR:-$HOME/.claxedo}"
NODE_DIR="$CLAXEDO_INSTALL_DIR/node"
NPM_PREFIX="$CLAXEDO_INSTALL_DIR/npm"
path_lines=""

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

remember_path() {
  path_lines="${path_lines}export PATH=\"$1:\$PATH\"
"
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    fail "curl or wget is required to download Node $NODE_MAJOR"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "sha256sum or shasum is required to verify the Node download"
  fi
}

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

install_node() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "Node $NODE_MAJOR is required; install it from https://nodejs.org and re-run (unsupported OS $(uname -s))" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "Node $NODE_MAJOR is required; install it from https://nodejs.org and re-run (unsupported arch $(uname -m))" ;;
  esac

  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  line="$(grep "node-v$NODE_MAJOR\.[0-9]*\.[0-9]*-$os-$arch\.tar\.gz\$" "$tmp/SHASUMS256.txt" | head -n 1)"
  [ -n "$line" ] || fail "no Node $NODE_MAJOR build for $os-$arch at $base"
  expected="$(printf '%s' "$line" | cut -d' ' -f1)"
  file="$(printf '%s' "$line" | awk '{print $2}')"
  say "Installing $file into $NODE_DIR"
  fetch "$base/$file" "$tmp/$file"
  actual="$(sha256_of "$tmp/$file")"
  [ "$actual" = "$expected" ] || fail "sha256 mismatch for $file: expected $expected, got $actual"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  PATH="$NODE_DIR/bin:$PATH"
  export PATH
  remember_path "$NODE_DIR/bin"
}

major="$(node_major || true)"
if [ -z "$major" ] || [ "$major" -lt "$NODE_MAJOR" ]; then
  if [ -n "$major" ]; then say "node $(node --version) found; claxedo needs $NODE_MAJOR or newer"; fi
  install_node
fi
command -v npm >/dev/null 2>&1 || fail "npm is missing next to $(command -v node)"

# `npm prefix -g` is the directory whose lib/node_modules and bin the install
# writes to; a system Node (apt, brew on Linux) usually owns it as root.
global_prefix="$(npm prefix -g)"
prefix_args=""
bin_dir="$global_prefix/bin"
if [ ! -w "$global_prefix/lib/node_modules" ] && [ ! -w "$global_prefix/lib" ] && [ ! -w "$global_prefix" ]; then
  prefix_args="--prefix $NPM_PREFIX"
  bin_dir="$NPM_PREFIX/bin"
  mkdir -p "$NPM_PREFIX"
  remember_path "$bin_dir"
fi

if [ -n "${CLAXEDO_CLI_TARBALL:-}" ]; then
  say "Installing @claxedo/cli from $CLAXEDO_CLI_TARBALL"
  # shellcheck disable=SC2086
  npm install -g --no-fund --no-audit --loglevel=error $prefix_args $CLAXEDO_CLI_TARBALL
else
  spec="@claxedo/cli@${CLAXEDO_CLI_VERSION:-latest}"
  say "Installing $spec"
  # shellcheck disable=SC2086
  npm install -g --no-fund --no-audit --loglevel=error $prefix_args "$spec"
fi

[ -x "$bin_dir/claxedo" ] || fail "npm finished but $bin_dir/claxedo is not there"
"$bin_dir/claxedo" --help >/dev/null || fail "$bin_dir/claxedo --help failed"

say ""
say "claxedo is installed at $bin_dir/claxedo"
if [ -n "$path_lines" ]; then
  say "Add this to your shell profile (~/.profile, ~/.bashrc or ~/.zshrc), then open a new shell:"
  printf '%s' "$path_lines" | sed 's/^/  /'
fi
say ""
say "Next, on this machine:"
say "  claxedo connect --token-file <file> --root <dir> --install-service"
say "The token file comes from 'claxedo host invite --name <machine> --root <dir>' run on a signed-in laptop."
