# @claxedo/cli

The `claxedo` command. On a laptop it signs you in and manages which machines
serve which folders; on a machine it enrolls with the control plane and serves
the assigned folders to your Claxedo sessions.

## Install

One line, no sudo, for the current user:

```sh
curl -fsSL https://raw.githubusercontent.com/kyashrathore/Claxedo/dev/packages/cli/install.sh | sh
```

`claxedo.dev/install.sh` will redirect to that file once the domain points at
it; the raw GitHub URL is the one that works today.

The script:

1. uses the `node` on your PATH when it is 24 or newer; otherwise downloads the
   current Node 24 release from nodejs.org (linux/darwin, x64/arm64, sha256
   checked) into `~/.claxedo/node` and prints the `PATH` line to add;
2. runs `npm install -g @claxedo/cli` — under `~/.claxedo/npm` when the global
   prefix is not writable, again printing the `PATH` line;
3. checks `claxedo --help` and prints the `connect` command to run next.

With Node 24 already installed you can skip the script:

```sh
npm install -g @claxedo/cli
```

Knobs: `CLAXEDO_CLI_VERSION=0.1.0` pins the version, `CLAXEDO_INSTALL_DIR`
moves `~/.claxedo`, and `CLAXEDO_CLI_TARBALL=./claxedo-cli-0.1.0.tgz` installs a
local pack instead of the registry (used to check a release before it is
published; several tarballs may be listed separated by spaces). Such a check
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
claxedo host invite --name N --root DIR... [--expires 1h] [--org-visible]
claxedo host list
claxedo host assign --machine <name|enrollment_id> <dir> [--name N]
claxedo host unassign --machine <name|enrollment_id> <dir>
claxedo host scope --machine <name|enrollment_id> --root DIR... [--org-visible]
claxedo host revoke --machine <name|enrollment_id>
```

`claxedo host --help` explains each one.

## Everything else

```
claxedo login
claxedo logout
claxedo status
claxedo whoami
claxedo deploy [--generate-only] [--app <name>] [--region <code>] [--yes]
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
ships the embedded OpenCode host and a native lock binding and is installed by
npm as the package's one dependency. Releases go through
`script/PUBLISH-ORDER.md` (track `cli`).
