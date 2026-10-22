# @claxedo/cli

The `claxedo` command. On a laptop it signs you in and manages which machines
serve which folders; on a machine it enrolls with the control plane and serves
the assigned folders to your Claxedo sessions.

## Install

On Linux and macOS, with Git installed:

```sh
curl -fsSL https://raw.githubusercontent.com/kyashrathore/Claxedo/dev/packages/cli/install.sh | sh
claxedo --version
```

`install.sh` uses the `node` on your PATH when it is 24 or newer, otherwise
downloads the current Node 24 release from nodejs.org (linux/darwin, x64/arm64,
sha256 checked) into `~/.claxedo/node`; installs under `~/.claxedo/npm` when
the global prefix is not writable, printing the `PATH` line to add; installs
`@claxedo/cli` with npm's install scripts off and then runs the one step the
workspace runtime needs, which applies its OpenCode patches with `git`; and
checks `claxedo --help`. It needs no compiler. Knobs: `CLAXEDO_CLI_VERSION`
pins the version, `CLAXEDO_INSTALL_DIR` moves `~/.claxedo`, and
`CLAXEDO_CLI_TARBALL` installs one or more local packs (space-separated)
instead of the registry. Such an install still lands in the real global prefix
when that prefix is writable — point `npm_config_prefix` at a scratch directory
to keep it out.

A plain `npm install -g @claxedo/cli` (Node 24 or newer) needs a C/C++
toolchain: `tree-sitter-powershell` 0.25.10, a dependency of the embedded
OpenCode engine, ships no prebuilt binary and compiles in its install script
with make, a C++ compiler and Python (`build-essential` and `python3` on
Debian/Ubuntu; on Windows the Visual Studio Build Tools Node's installer offers
to add). OpenCode reads only that package's `.wasm`, so elsewhere, Windows
among them, take `install.sh`'s two steps by hand, with Git on `PATH` (the
second command is POSIX shell; in PowerShell spell the path out):

```sh
npm install -g --ignore-scripts @claxedo/cli
node "$(npm root -g)/@claxedo/cli/node_modules/@claxedo/workspace-runtime/scripts/install-opencode-node.mjs"
```

From a checkout, with Bun and Node 24:

```sh
bun install
bun run build:packages            # the dist/ of the workspace packages the cli loads under Node
bun run --cwd packages/cli build
node packages/cli/dist/index.mjs --help
```

`bun run --cwd packages/cli dev -- --help` runs the source under Bun instead.
[`script/PUBLISH-ORDER.md`](../../script/PUBLISH-ORDER.md) describes how the
package is published.

## Connect a machine

On a signed-in laptop (`claxedo login`), mint a single-use invitation scoped to
the folders the machine may serve:

```sh
claxedo host invite --name build-box --root /srv/projects
```

The token prints once. Copy it into a file on the machine, then:

```sh
claxedo connect --token-file ./invite.token --root /srv/projects --install-service
```

That redeems the invitation, removes the token file, and installs a user
service (`systemd --user` on Linux, a LaunchAgent on macOS) that keeps
`claxedo connect --foreground` running. `claxedo connect --help` documents every
flag, the exit codes (78 = the control plane decided against this machine, so a
service manager must not restart into it), and what a user service does and
does not isolate.

## Owner commands

```
claxedo host invite --name N --root DIR... [--expires 1h]
claxedo host list
claxedo host assign --machine <name|enrollment_id> <dir> [--name N]
claxedo host unassign --machine <name|enrollment_id> <dir>
claxedo host scope --machine <name|enrollment_id> --root DIR...
claxedo host revoke --machine <name|enrollment_id>
```

`claxedo host --help` explains each one.

## Everything else

```
claxedo login
claxedo logout
claxedo status
claxedo whoami
claxedo documents ...
```

## Development

```sh
bun run build      # esbuild bundle -> dist/index.mjs
bun run dev -- --help
bun run test
bun run typecheck
```

`dist/index.mjs` bundles everything except `@claxedo/workspace-runtime`, which
ships the embedded OpenCode host and a native lock binding, and
`better-sqlite3`, a native module; they are the package's two runtime
dependencies. `bun run verify:publish` runs the built bin under the `node` on
`PATH`.
