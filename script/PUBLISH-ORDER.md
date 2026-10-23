# Publish order

Dependency-ordered publish sequence for the 10 public `@claxedo/*` packages,
derived from the actual `dependencies` in each `packages/*/package.json`.

- **Re-derived:** 2026-10-22
- **Previous release:** 2026-10-22 (`helpers` 0.2.1, runtime 0.10.1, `cli`
  0.2.1); `channels` and `connections` last published 0.4.0 on 2026-07-30

`packages/claxedo-server` is `"private": true` and is **not** published; it is
the workspace that hosts the release tooling, nothing more.

## Version scheme

Four version tracks. Packages on a track move together, one step at a time.
`publish-claxedo-packages.ts` reads every version from the repo — the tracks
are a review convention it selects on (`--track`), not a number it computes.
The cost is that a package with no content change still gets a bump; the
benefit is that a cross-pin is always "the same number", which is the class of
mistake that has actually bitten this repo.

| Track | Packages | On npm | In the repo |
|---|---|---|---|
| helpers | `helpers` | 0.2.1 | **0.2.2** |
| runtime | `agent-runtime-contract`, `sandbox-contract`, `sandbox-manager`, `workspace-relay`, `workspace-relay-protocol`, `workspace-runtime` | 0.10.1 | **0.10.2** |
| apps | `channels`, `connections` | 0.4.0 | **0.5.0** |
| cli | `cli` | 0.2.1 | **0.2.2** |

0.10.2 and 0.2.2 are patch releases of what changed since 0.10.1. Two exports
change: `workspace-runtime` adds `installedTerminalAgents`, and
`sandbox-contract`'s `sandboxCheckpointUnusableCauses` no longer lists
`runtime_outdated`, since a workspace saved below the floor now wakes on the
current runtime instead of refusing. `workspace-runtime` and the packages it
bundles carry a connected machine's direct route on its private network, its
owner's accounts spent through the egress broker, the control plane's allowed
answers reused for up to a minute, Pi's shell in Git Bash on Windows, and a
Claude model probe retired when its transport is disposed. `sandbox-manager`
resumes a Boat image pull the registry link breaks and serves one runtime
floor, and `workspace-relay` changed with its workerd test fixture.
`agent-runtime-contract` and `workspace-relay-protocol` ride the track. `cli`
moves because the code it bundles changed (`claxedo connect --pair`, a
machine's reports and the pairing transport in `host-connector`) and so that it
pins `workspace-runtime` 0.10.2; the control plane's connect script reuses an
installed CLI only at 0.2.2 or later (`MINIMUM_CONNECT_CLI_VERSION` in
`@claxedo/account-contract/machine`), so pairing a machine needs 0.2.2 on npm.
`helpers` 0.2.2 adds `powershellQuote`, `isPrivateNetworkAddress` and
`reconnectDelayMs`; the packages that depend on it pin 0.2.2.

`helpers` rides its own track because both the runtime and apps tracks depend
on it — `agent-runtime-contract`, `sandbox-manager` and `workspace-runtime` on
the runtime track, `connections` on apps. Folding it into either would make the
other track's packages pin a number that moves for reasons unrelated to them.

`cli` rides its own track because it is a command, not a library: nothing
depends on it, and it moves whenever any of the many unpublished packages it
bundles changes, which says nothing about the runtime's API.

## Sibling pins are `workspace:*`

Every `@claxedo/*` dependency inside the repo is written `"workspace:*"`. Bun
resolves it to the checkout regardless of version numbers, so a bump can never
flip a sibling to the registry. The publisher materializes the exact in-repo
version only inside the packed tarball and restores the repo manifest after.

## Unpublished siblings are bundled

An unpublished workspace package has no registry version to pin, so the
publisher drops it from every section of the packed manifest, and the public
package's npm build inlines its code into the `dist`. Whatever the `dist` still
imports must be one of the package's own `dependencies`, at the version a
bundled sibling declares where one does; the publisher reads the packed
tarball's JavaScript and refuses one that imports anything else, an unpublished
sibling the build failed to inline included.

- `sandbox-manager` bundles `egress-broker`, a devDependency.
- `workspace-runtime` bundles `harness`, `session-core`, `process-ownership`,
  `plugin-api` and `status-hooks` (`INLINED_WHEN_PUBLISHED` in
  `scripts/build.ts`). They stay in its `dependencies` because its repo build
  (`build`) imports them at run time: it leaves them external, since the
  desktop's server bundle consumes this `dist` beside `local-server` and
  `server-core`, which import those packages themselves, and must not carry a
  second copy. Its npm build (`build:publish`) inlines them in one split
  build, so each exists once across every entry, leaves every npm package
  external, and puts the Cursor SDK worker and the launch gate child beside
  the chunks that spawn them. The publisher runs a package's `build:publish`
  when it has one, `build` otherwise.
- `cli` bundles everything it imports except `@claxedo/workspace-runtime` and
  `better-sqlite3`, its two dependencies; its unpublished siblings are
  devDependencies.

## A published version is immutable

`check-published-versions.ts` (run by the publisher and by the dry-run job)
fails when a package directory changed after its `version` was last set and
that version is already on npm, unless the tree, built as it would be
published, packs to the bytes already on npm. A package's directory includes
the unpublished siblings its dist bundles (its unpublished dependencies and
devDependencies, and their unpublished dependencies). Bump the track before
merging such a change.

## Dependency graph (`@claxedo/*` edges only)

```
Tier 0 — no @claxedo/* dependencies
  helpers

Tier 1
  agent-runtime-contract   -> helpers
  workspace-relay-protocol -> helpers
  sandbox-contract         -> helpers
  channels                 -> helpers
  connections              -> helpers
  workspace-relay          -> workspace-relay-protocol, helpers

Tier 2
  sandbox-manager    -> sandbox-contract, helpers    (bundles egress-broker)
  workspace-runtime  -> agent-runtime-contract, workspace-relay,
                        workspace-relay-protocol, helpers
                                                     (bundles harness, session-core,
                                                      process-ownership, plugin-api,
                                                      status-hooks)

Tier 3
  cli                -> workspace-runtime            (bundles the rest)
```

`helpers` sits under every other package: each imports a canonical guard or
string helper from it. `sandbox-manager` depends on `sandbox-contract` rather
than `workspace-runtime` — that pin was replaced by a constant in
`src/runtime-version.ts` — so the contract keeps publishing ahead of the
manager.

This order is asserted by a test
(`packages/claxedo-server/scripts/release/tests/publish-claxedo-packages.test.ts`,
"is listed in dependency order"), which reads the real `package.json` files, so
it fails if a new `@claxedo/*` edge is added without reordering.

## Publishing

Do not run `npm publish` by hand. Both paths below build, pack, inspect the
real tarball, and skip any package whose exact version is already on the
registry, so they are safe to re-run after a partial failure.

### One command for all 10

```bash
# from the repo root, with Node 24 on PATH
bun run --cwd packages/claxedo-server release:packages --track all --dry-run
bun run --cwd packages/claxedo-server release:packages --track all
```

`release:packages` reads each version from its `package.json` — there is no
`--version` argument, because the bump is meant to be a reviewed commit rather
than a number typed at release time. `--track` accepts `all` or a version
track name (`helpers`, `runtime`, `apps`, `cli`). `--packages a,b` selects by
name or directory. `--tag` sets the dist-tag (default `latest`); `--no-provenance`
disables provenance. A track publishes only its own packages, so publish the
tracks it depends on first: `cli` needs `runtime`, which needs `helpers`.

It refuses to publish when any of these is true, per package:

- a `@claxedo/*` dependency pin does not equal that package's in-repo version
- the package is `"private": true`
- the publish build or a package's own `verify:publish` fails
- the **packed** `package.json` still carries a `workspace:` or `catalog:`
  specifier in `dependencies` / `peerDependencies` / `optionalDependencies`
  (a `catalog:` in `devDependencies` is reported but allowed — npm never
  installs a published package's devDependencies)
- the packed JavaScript imports a package the packed manifest does not
  declare — an unpublished sibling among them — or the manifest declares a
  dependency at a different version than a sibling the package bundles
- `README.md` or `LICENSE` is missing from the tarball
- the packed version does not match the repo version

`workspace-runtime`'s `verify:publish` checks its exports against
`docs/api-manifest.json` and its README, runs its bin and the ACP question
package smoke; `cli`'s checks that `dist/claxedo-migration` holds every
migration of the journal and runs `claxedo --version`, `--help` and
`connect --help`. Both need Node 24 on `PATH`.

### Via GitHub Actions

`claxedo-packages-release.yml` — `workflow_dispatch` with a `track` choice
(`all`, `helpers`, `runtime`, `apps`, `cli`), `npm_tag`, and a `dry_run` toggle
that defaults to **true**. Uses the existing `NPM_TOKEN` secret and `id-token:
write` for provenance. The same workflow runs `--track all --dry-run`
automatically on every push to `dev` (and on PRs) touching any public package
dir, a sibling one bundles, or the release tooling. There is no second
publisher.

### Pre-publish gate

```bash
bun run --cwd packages/claxedo-server release:packages --track all --dry-run
```

This is the whole gate: sibling pins are `workspace:*`, no published version
has unreleased changes behind it, every package builds, packs, and its tarball
carries README.md, LICENSE, no `workspace:`/`catalog:` specifier and no
undeclared import. A version already on npm is reported as skipped, so the dry
run is safe to repeat after a release.

## Post-publish verification

```bash
for name in \
  @claxedo/helpers \
  @claxedo/agent-runtime-contract \
  @claxedo/sandbox-contract \
  @claxedo/sandbox-manager \
  @claxedo/workspace-relay \
  @claxedo/workspace-relay-protocol \
  @claxedo/workspace-runtime \
  @claxedo/channels \
  @claxedo/connections \
  @claxedo/cli \
; do
  echo "$name -> $(npm view "$name" version 2>/dev/null || echo 'NOT FOUND')"
done
```

Expect `0.2.2` for `@claxedo/helpers` and `@claxedo/cli`, `0.10.2`
for the runtime track, and `0.5.0` for the apps track. A line still showing the old
version means either the registry has not finished indexing (retry) or that
package's publish failed and must be re-run before anything downstream of it in
the graph above.

## Known issues, deliberately not fixed here

- `workspace-runtime`'s published declarations still import types from the
  unpublished `session-core`, `harness`, `process-ownership` and `plugin-api`,
  so a TypeScript consumer sees those types as unresolved. Its JavaScript is
  self-contained; the CLI ships no declarations.
- `npm install` runs the install scripts of the embedded OpenCode SDK's
  closure. `tree-sitter-powershell` 0.25.10 (a dependency of
  `@opencode-ai/core`) ships no prebuilt binary and compiles with node-gyp on
  every platform, so a machine without make, a C++ compiler and Python fails
  the install. OpenCode reads only its `.wasm`, so the cli's `install.sh`
  installs with `--ignore-scripts` and then runs `workspace-runtime`'s
  `scripts/install-opencode-node.mjs`, which needs no toolchain
  (`packages/cli/src/install-sh.test.ts` pins both steps). That
  postinstall applies its OpenCode patches with `git`, which must be on
  `PATH`. `better-sqlite3` is pinned at 13.0.3, the first 13.x with no install
  script and prebuilds for every platform in the package.
- `workspace-runtime` still carries `Copyright (c) 2025 opencode`
  in `LICENSE`; the published packages read `Copyright (c) 2026 Claxedo`. Cosmetic, and a
  call for the owner rather than the release tooling.
- `packages/sandbox-manager/src/runtime-version.ts` pins
  `DEFAULT_WORKSPACE_RUNTIME_VERSION = "0.5.2"`, which is a **sandbox image
  tag**, not a package version. It intentionally does not track
  `workspace-runtime`'s npm version and must only move when an image is built
  and pushed at the new tag.
