#!/bin/sh
# Installs the claxedo command for the current user, with no sudo, and given a
# pairing code from Claxedo's "Connect a machine…" also connects this machine,
# sharing the folder the command runs in once its owner approves it. Given the
# drawer's pre-approved invitation instead, it connects with no approval and
# shares the folder --root names, which is how cloud-init connects a server.
#
#   curl -fsSL https://raw.githubusercontent.com/kyashrathore/Claxedo/dev/packages/cli/install.sh | sh
#   curl -fsSL https://<control plane>/api/claxedo/connect | sh -s -- <pairing code>
#   curl -fsSL https://<control plane>/api/claxedo/connect | sh -s -- --invitation <token> --root <folder>
#
# The control plane serves this file at /api/claxedo/connect with
# CLAXEDO_CONTROL_PLANE_URL and CLAXEDO_CLI_MIN_VERSION set above this line, so
# a code is always redeemed where it was minted.
#
# Environment:
#   CLAXEDO_CLI_VERSION   npm version or dist-tag to install (default: latest)
#   CLAXEDO_CLI_TARBALL   one or more local .tgz paths, space-separated; installed
#                         instead of the registry package (a release-check seam)
#   CLAXEDO_INSTALL_DIR   where a private Node and npm prefix go (default: ~/.claxedo)
set -eu

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

pairing_code=""
invitation=""
root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --invitation | --root)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 needs a value; copy the command from Connect a machine… again."
      if [ "$1" = --invitation ]; then invitation="$2"; else root="$2"; fi
      shift 2
      ;;
    -*) fail "Unknown option $1; copy the command from Connect a machine… again." ;;
    *)
      [ -z "$pairing_code" ] || fail "Give one pairing code; copy the command from Connect a machine… again."
      pairing_code="$1"
      shift
      ;;
  esac
done
if [ -n "$invitation" ]; then
  [ -z "$pairing_code" ] || fail "Give a pairing code or an invitation, not both."
  case "$root" in
    /*) ;;
    "") fail "--root names the folder to share; copy the command from Connect a machine… again." ;;
    *) fail "--root must be an absolute path on this machine: $root" ;;
  esac
elif [ -n "$root" ]; then
  fail "--root goes with --invitation; a pairing code shares the folder the command runs in."
fi

# A cloud-init run can start with no HOME.
[ -n "${HOME:-}" ] || HOME="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)"
[ -n "$HOME" ] || fail "HOME is not set and $(id -un) has no home folder; set HOME and run this again."
export HOME

NODE_MAJOR=24
CLAXEDO_INSTALL_DIR="${CLAXEDO_INSTALL_DIR:-$HOME/.claxedo}"
NODE_DIR="$CLAXEDO_INSTALL_DIR/node"
NPM_PREFIX="$CLAXEDO_INSTALL_DIR/npm"
path_lines=""
step_index=0
if [ -n "$pairing_code" ]; then step_total=4; elif [ -n "$invitation" ]; then step_total=3; else step_total=2; fi

step() {
  step_index=$((step_index + 1))
  say "$step_index/$step_total $*"
}

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

json_text() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# The code is checked before anything is installed: an expired or spent code
# fails here in one line instead of after minutes of npm.
report_pairing() {
  plane="${CLAXEDO_CONTROL_PLANE_URL:-}"
  [ -n "$plane" ] || fail "This script was not served by Claxedo; copy the command from Connect a machine… again."
  host="$(hostname 2>/dev/null || uname -n)"
  body="{\"code\":\"$(json_text "$pairing_code")\",\"hostname\":\"$(json_text "$host")\",\"os\":\"$(uname -s)\"}"
  if command -v curl >/dev/null 2>&1; then
    answer="$(curl -sS -X POST -H 'content-type: application/json' --data "$body" "$plane/api/claxedo/host/pairings/progress" 2>/dev/null)" \
      || fail "Cannot reach $plane; check this machine's network or proxy."
  else
    answer="$(wget -qO- --header='content-type: application/json' --post-data="$body" "$plane/api/claxedo/host/pairings/progress" 2>/dev/null)" \
      || fail "Cannot reach $plane; check this machine's network or proxy."
  fi
  case "$answer" in
    *'"recorded":true'*) ;;
    *pairing_expired*) fail "This code expired; open Connect a machine… in Claxedo for a new one." ;;
    *pairing_used*) fail "This code was already used; open Connect a machine… in Claxedo for a new one." ;;
    *pairing_owner_signed_out*) fail "The person who made this code signed out; make a new one in Claxedo." ;;
    *pairing_invalid*) fail "This code is not valid; copy the command from Connect a machine… again." ;;
    *) fail "Claxedo did not accept this code; copy the command from Connect a machine… again." ;;
  esac
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
  say "    installing $file into $NODE_DIR"
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

ensure_node() {
  step "Node $NODE_MAJOR"
  major="$(node_major || true)"
  if [ -z "$major" ] || [ "$major" -lt "$NODE_MAJOR" ]; then
    if [ -n "$major" ]; then say "    node $(node --version) found; claxedo needs $NODE_MAJOR or newer"; fi
    install_node
  fi
  command -v npm >/dev/null 2>&1 || fail "npm is missing next to $(command -v node)"
  command -v git >/dev/null 2>&1 || fail "git is required: the workspace runtime applies its OpenCode patches with it"
}

# An installed claxedo is kept when this control plane accepts its version.
accepted_cli() {
  [ -n "${CLAXEDO_CLI_MIN_VERSION:-}" ] && [ -z "${CLAXEDO_CLI_TARBALL:-}" ] || return 1
  installed="$(command -v claxedo 2>/dev/null)" || return 1
  version="$("$installed" --version 2>/dev/null)" || return 1
  node -e 'const [a, b] = process.argv.slice(1).map((v) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number)); const d = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; process.exit(d >= 0 ? 0 : 1)' "$version" "$CLAXEDO_CLI_MIN_VERSION" 2>/dev/null || return 1
  bin_dir="$(dirname "$installed")"
  say "    claxedo $version is already installed"
}

install_cli() {
  step "claxedo"
  if accepted_cli; then return 0; fi
  # The global prefix is the directory whose lib/node_modules and bin the install
  # writes to; a system Node (apt, brew on Linux) usually owns it as root. It is
  # read from the environment npm gives a command it runs, not from `npm prefix
  # -g` or `npm config get prefix`: npm 11 prints a UUID-shaped path segment as
  # `***` in its own output and refuses `config get prefix` when the prefix comes
  # from the environment.
  # shellcheck disable=SC2016
  global_prefix="$(npm exec --yes=false -c 'printf %s "$npm_config_global_prefix"')"
  [ -n "$global_prefix" ] || fail "npm did not report its global prefix"
  install_prefix="$global_prefix"
  prefix_args=""
  bin_dir="$global_prefix/bin"
  if [ ! -w "$global_prefix/lib/node_modules" ] && [ ! -w "$global_prefix/lib" ] && [ ! -w "$global_prefix" ]; then
    install_prefix="$NPM_PREFIX"
    prefix_args="--prefix $NPM_PREFIX"
    bin_dir="$NPM_PREFIX/bin"
    mkdir -p "$NPM_PREFIX"
    remember_path "$bin_dir"
  fi

  # Install scripts stay off: tree-sitter-powershell, which OpenCode reads only as
  # .wasm, compiles in its own and would need make, a C++ compiler and Python. The
  # one script the install needs, the runtime's OpenCode patch step, runs below.
  if [ -n "${CLAXEDO_CLI_TARBALL:-}" ]; then
    say "    installing @claxedo/cli from $CLAXEDO_CLI_TARBALL"
    # shellcheck disable=SC2086
    npm install -g --ignore-scripts --no-fund --no-audit --loglevel=error $prefix_args $CLAXEDO_CLI_TARBALL \
      || fail "npm install of $CLAXEDO_CLI_TARBALL failed"
  else
    spec="@claxedo/cli@${CLAXEDO_CLI_VERSION:-latest}"
    say "    installing $spec"
    # shellcheck disable=SC2086
    npm install -g --ignore-scripts --no-fund --no-audit --loglevel=error $prefix_args "$spec" \
      || fail "npm install of $spec failed"
  fi

  # Not `npm root -g`: npm 11 prints a UUID-shaped path segment as `***`.
  global_root="$install_prefix/lib/node_modules"
  runtime_dir="$global_root/@claxedo/cli/node_modules/@claxedo/workspace-runtime"
  [ -d "$runtime_dir" ] || runtime_dir="$global_root/@claxedo/workspace-runtime"
  node "$runtime_dir/scripts/install-opencode-node.mjs" >/dev/null \
    || fail "applying the workspace runtime's OpenCode patches in $runtime_dir failed"

  [ -x "$bin_dir/claxedo" ] || fail "npm finished but $bin_dir/claxedo is not there"
  "$bin_dir/claxedo" --help >/dev/null || fail "$bin_dir/claxedo --help failed"
}

# A user service outlives the login only while lingering is on, which root and,
# where polkit allows it, the user may turn on; `systemctl --user` then finds
# the user manager through XDG_RUNTIME_DIR, which a cloud-init run leaves unset
# and the manager's bus takes a moment to appear under. loginctl reads no
# stdin: under `curl | sh` stdin is the rest of this script.
enable_linger() {
  [ "$(uname -s)" = Linux ] && command -v loginctl >/dev/null 2>&1 || return 0
  user="$(id -un)"
  if [ "$(loginctl show-user "$user" --property=Linger --value </dev/null 2>/dev/null)" != yes ]; then
    if ! loginctl --no-ask-password enable-linger "$user" </dev/null >/dev/null 2>&1; then
      say "    run \`sudo loginctl enable-linger $user\` so the service runs while no one is logged in"
      return 0
    fi
    say "    lingering is on for $user, so the service runs while no one is logged in"
  fi
  [ -z "${XDG_RUNTIME_DIR:-}" ] || return 0
  runtime_dir="/run/user/$(id -u)"
  waited=0
  while [ ! -S "$runtime_dir/bus" ] && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if [ -S "$runtime_dir/bus" ]; then
    XDG_RUNTIME_DIR="$runtime_dir"
    export XDG_RUNTIME_DIR
  fi
}

write_invitation() {
  token_file="$CLAXEDO_INSTALL_DIR/invitation.token"
  mkdir -p "$CLAXEDO_INSTALL_DIR"
  rm -f "$token_file"
  (umask 077 && printf '%s\n' "$invitation" >"$token_file") || fail "cannot write the invitation to $token_file"
}

print_path_lines() {
  if [ -n "$path_lines" ]; then
    say "Add this to your shell profile (~/.profile, ~/.bashrc or ~/.zshrc), then open a new shell:"
    printf '%s' "$path_lines" | sed 's/^/  /'
  fi
}

if [ -n "$pairing_code" ]; then
  step "Checking the code with Claxedo"
  report_pairing
fi
ensure_node
install_cli
if [ -n "$invitation" ]; then
  step "Connecting this machine"
  write_invitation
  enable_linger
  print_path_lines
  exec "$bin_dir/claxedo" connect --token-file "$token_file" --root "$root" --install-service
fi
if [ -z "$pairing_code" ]; then
  say ""
  say "claxedo is installed at $bin_dir/claxedo"
  print_path_lines
  say ""
  say "Next, connect this machine from Claxedo: Settings → Machines → Connect a machine…"
  exit 0
fi
step "Connecting this machine"
enable_linger
print_path_lines
exec "$bin_dir/claxedo" connect --pair "$pairing_code" --install-service
