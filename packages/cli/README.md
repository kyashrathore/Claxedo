# @claxedo/cli

The `claxedo` command. On a laptop it signs you in and manages which machines
serve which folders; on a machine it enrolls with the control plane and serves
the assigned folders to your Claxedo sessions.

## Install

`@claxedo/cli` is not published from this repository yet
([`script/PUBLISH-ORDER.md`](../../script/PUBLISH-ORDER.md) says why), and the
`0.1.0` on npm predates this code. Run it from a checkout, with Bun and Node 24
or newer:

```sh
bun install
bun run build:packages            # the dist/ of the workspace packages the cli loads under Node
bun run --cwd packages/cli build
node packages/cli/dist/index.mjs --help
```

`bun run --cwd packages/cli dev -- --help` runs the source under Bun instead.

`install.sh` is the one-line installer for once the package is published: it
installs `@claxedo/cli` from npm, so until then it installs only the stale
release. It uses the `node` on your PATH when it is 24 or newer, otherwise
downloads the current Node 24 release from nodejs.org (linux/darwin, x64/arm64,
sha256 checked) into `~/.claxedo/node`; installs under `~/.claxedo/npm` when the
global prefix is not writable, printing the `PATH` line to add; and checks
`claxedo --help`. Knobs: `CLAXEDO_CLI_VERSION` pins the version,
`CLAXEDO_INSTALL_DIR` moves `~/.claxedo`, and `CLAXEDO_CLI_TARBALL` installs one
or more local packs (space-separated) instead of the registry. Such an install
still lands in the real global prefix when that prefix is writable — point
`npm_config_prefix` at a scratch directory to keep it out.

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
ships the embedded OpenCode host and a native lock binding and stays the
package's one runtime dependency.
