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

In Claxedo, **Connect a machine…** shows one command with a pairing code in it.
Run it on the machine, in the folder you want to share:

```sh
curl -fsSL https://app.claxedo.com/api/claxedo/connect | sh -s -- K7QM4PXD9R2TWB6HJ3NF
```

On Windows the drawer's Windows tab shows the PowerShell twin, which fetches
`connect.ps1` instead. The script is `install.sh` (or `install.ps1`) served by
the control plane with its own URL set inside, so a code is redeemed where it
was minted. It reuses an installed `claxedo` the control plane accepts, else
installs one as below, then runs `claxedo connect --pair <code>
--install-service`. The machine waits for you to approve it in the app; the
approval names it, makes the folder the command ran in its one root and shares
that folder. A denial, or 15 minutes with no answer, ends the command with exit
78 and one line saying why. The code is single use and lasts 15 minutes; signing
out of the app cancels the codes no machine has used yet.

Run the command again in another folder on a machine that is already connected
and it asks you, in the app, to share that folder too; it never enrolls the
machine twice. On a machine whose owner removed it, or that is connected to
another control plane, it asks once before connecting again.

For a server no one approves from a browser, such as a cloud VM on its first
boot, the drawer's **For a server without a browser** takes a name and the
folder to share, typed as the server writes it, and mints a pre-approved
invitation. It shows a cloud-init snippet and the same as one command:

```sh
curl -fsSL https://app.claxedo.com/api/claxedo/connect | sh -s -- --invitation chx_inv_2.… --root '/srv/app'
```

`connect.ps1` takes `-Invitation` and `-Root`. The script writes the invitation
to a file only this user can read and runs `claxedo connect --token-file <file>
--root <folder> --install-service`: the machine connects with no approval, the
control plane makes the folder its one root and assigns it as its first
workspace, and the invitation's name is the machine's. On Linux the script turns
lingering on where it may (root, which is what cloud-init runs as, always may)
and otherwise prints the one command that does, so the service runs with no one
logged in. The invitation works once, within the hour.

A signed-in CLI mints the same kind of invitation, scoped to any folders. On a
signed-in laptop (`claxedo login`), mint a single-use invitation scoped to the
folders the machine may serve:

```sh
claxedo host invite --name build-box --root /srv/projects
```

The token prints once. Copy it into a file on the machine, then:

```sh
claxedo connect --token-file ./invite.token --root /srv/projects --install-service
```

That redeems the invitation, removes the token file, and installs a user
service (`systemd --user` on Linux, a LaunchAgent on macOS) that keeps
`claxedo connect --foreground` running. The unit carries the PATH of the shell
that installed it, so the service finds the same `codex`, `node` and other
tools the shell does; run `--install-service` again after changing it or after
updating the CLI, since it restarts a service that already runs. `claxedo connect --help` documents every
flag, the exit codes (78 = the control plane decided against this machine, so a
service manager must not restart into it), and what a user service does and
does not isolate.

A connected machine reports its CLI version and system to the control plane
each time it starts serving. When it cannot serve, it reports why with the
command that fixes it: its service could not start (lingering off, no user
manager, or a Windows task waiting for its user's logon), the desktop app's
daemon already runs beside it, or it was stopped. Settings → Machines shows that
line until the machine next starts serving, and a CLI below the version the
control plane accepts shows the command that updates it.

`claxedo doctor` checks, one line each, what a connected machine needs: Node
24, the control plane and the relay it uses answering, the enrollment, the
service running with your PATH, `git`, the agent CLIs it finds, and on Windows
the Git Bash Pi runs commands in. It exits 1 when any check fails.

## Owner commands

```
claxedo host invite --name N --root DIR... [--expires 1h]
claxedo host list
claxedo host assign --machine <name|enrollment_id> <dir> [--name N]
claxedo host unassign --machine <name|enrollment_id> <dir>
claxedo host scope --machine <name|enrollment_id> --root DIR...
claxedo host pause --machine <name|enrollment_id>
claxedo host resume --machine <name|enrollment_id>
claxedo host revoke --machine <name|enrollment_id>
```

`claxedo host --help` explains each one.

## Everything else

```
claxedo login
claxedo logout
claxedo status
claxedo doctor
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
