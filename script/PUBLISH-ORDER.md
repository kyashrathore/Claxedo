# Publish order

Dependency-ordered publish sequence for the 13 public `@claxedo/*` packages,
derived from the actual `dependencies` in each `packages/*/package.json`.

- **Re-derived:** 2026-09-14
- **Previous release:** 2026-07-30 (`0.7.0` / `0.4.0` / `0.3.0`)

`packages/claxedo-server` is `"private": true` and is **not** published; it is
the workspace that hosts the release tooling, nothing more.

## Version scheme

Five version tracks. Packages on a track move together, one step at a time.
`publish-claxedo-packages.ts` reads every version from the repo — the tracks
are a review convention it selects on (`--track`), not a number it computes.
The cost is that a package with no content change still gets a bump; the
benefit is that a cross-pin is always "the same number", which is the class of
mistake that has actually bitten this repo.

| Track | Packages | Previous | This release |
|---|---|---|---|
| helpers | `helpers` | — | **0.1.0** |
| runtime | `agent-runtime-contract`, `agent-event-runtime`, `agent-sdk-runtime`, `sandbox-contract`, `sandbox-manager`, `workspace-relay`, `workspace-relay-protocol`, `workspace-runtime` | 0.7.0 | **0.8.0** |
| apps | `channels`, `connections` | 0.4.0 | **0.5.0** |
| wakes | `wakes` | 0.3.0 | **0.4.0** |
| cli | `cli` | — | **0.1.0** |

`agent-runtime-contract` has never been published: the 0.7.0 release pinned it
from three siblings but did not publish it. 0.8.0 is its first release.

`cli` is the `claxedo` command (`npm install -g @claxedo/cli`). It rides its
own track because it is an application, not a library: it moves when a
command changes, which has nothing to do with the runtime's API. Its only
runtime dependency is `workspace-runtime` (the embedded OpenCode host cannot be
bundled — `dist/opencode-node` ships a native lock binding); `helpers`,
`host-connector` and `host-serving` are `devDependencies` folded into
`dist/index.mjs` by esbuild. `install.sh` in the package directory is the
one-line installer documented in `packages/cli/README.md`. 0.1.0 is its first
release.

`helpers` rides its own track because both other tracks depend on it —
`agent-event-runtime`, `agent-sdk-runtime` and `workspace-runtime` on the
runtime track, `connections` on apps. Folding it into either would
make the other track's packages pin a number that moves for reasons unrelated
to them. 0.1.0 is its first release.

## Sibling pins are `workspace:*`

Every `@claxedo/*` dependency inside the repo is written `"workspace:*"`. Bun
resolves it to the checkout regardless of version numbers, so a bump can never
flip a sibling to the registry. The publisher materializes the exact in-repo
version only inside the packed tarball and restores the repo manifest after.

## A published version is immutable

`check-published-versions.ts` (run by the publisher and by the dry-run job)
fails when a package directory changed after its `version` was last set and
that version is already on npm. Bump the track before merging such a change.

Each track moves a **minor** when at least one package on it added public
API since the previous publish. For 0.1.0 / 0.8.0 / 0.5.0 / 0.4.0 (2026-09-06):

- helpers — first release. `@claxedo/helpers` is the canonical owner for the
  small predicates and string/fs/path/process/net helpers the workspace kept
  rewriting; `script/helpers/verify.ts` enforces that ownership.
- runtime — `workspace-runtime` now runs the embedded OpenCode SDK on Node
  (the patched `@opencode-ai/*` beta-18684 closure with a koffi lock binding,
  shipped as `dist/opencode-node`), `agent-sdk-runtime` gained the Pi harness
  and the subagent-admission surface, and `agent-runtime-contract` is
  published for the first time. `sandbox-contract`, `sandbox-manager`,
  `workspace-relay` moves its Bun runtime adapter (`createWorkspaceRelayBun`
  and friends) off the root barrel to the `@claxedo/workspace-relay/bun`
  subpath, so the root entry typechecks under Node type roots;
  `workspace-relay-protocol` rides the track.
- apps — `connections` changed with the control-plane migration;
  `channels` rides the track.
- wakes — 0.4.0 was bumped in the repo before this release and never
  published; it ships now.
- cli — first release (2026-09-14). `@claxedo/cli` replaces the never-published
  `@opencode-ai/cli` (`lildax`) manifest that lived in `packages/cli`.

## Dependency graph (`@claxedo/*` edges only)

```
Tier 0 — no @claxedo/* dependencies
  helpers
  wakes

Tier 1
  agent-runtime-contract -> helpers
  workspace-relay-protocol -> helpers
  sandbox-contract   -> helpers
  agent-event-runtime -> agent-runtime-contract, helpers
  channels           -> helpers
  connections        -> helpers
  workspace-relay    -> workspace-relay-protocol, helpers

Tier 2
  sandbox-manager    -> sandbox-contract, helpers
  agent-sdk-runtime  -> agent-event-runtime, agent-runtime-contract, helpers

Tier 3
  workspace-runtime  -> agent-sdk-runtime, agent-event-runtime, agent-runtime-contract,
                        workspace-relay, workspace-relay-protocol, helpers

Tier 4
  cli                -> workspace-runtime            (build-time only: helpers)
```

`helpers` sits under everything but `wakes`: eleven of the other twelve import a
canonical guard or string helper from it, which is what pulls `agent-runtime-contract`,
`workspace-relay-protocol`, `sandbox-contract`, `channels` and `connections`
out of tier 0 and pushes `sandbox-manager` and `workspace-runtime` down a tier. `sandbox-manager` still depends on
`sandbox-contract` rather than `workspace-runtime` — that pin was replaced by a
constant in `src/runtime-version.ts` — so the contract keeps publishing ahead of
the manager.

This order is asserted by a test
(`packages/claxedo-server/scripts/release/tests/publish-claxedo-packages.test.ts`,
"is listed in dependency order"), which reads the real `package.json` files, so
it fails if a new `@claxedo/*` edge is added without reordering.

## Publishing

Do not run `npm publish` by hand. Both paths below build, pack, inspect the
real tarball, and skip any package whose exact version is already on the
registry, so they are safe to re-run after a partial failure.

### One command for all 13

```bash
# from the repo root
bun run --cwd packages/claxedo-server release:packages --track all --dry-run
bun run --cwd packages/claxedo-server release:packages --track all
```

`release:packages` reads each version from its `package.json` — there is no
`--version` argument, because the bump is meant to be a reviewed commit rather
than a number typed at release time. `--track` accepts `all` or a version
track name (`helpers`, `runtime`, `apps`, `wakes`, `cli`). `--packages a,b` selects by
name or directory. `--tag` sets the dist-tag (default `latest`); `--no-provenance`
disables provenance.

It refuses to publish when any of these is true, per package:

- a `@claxedo/*` dependency pin does not equal that package's in-repo version
- the package is `"private": true`
- `npm run build` or a package's own `verify:publish` fails
- the **packed** `package.json` still carries a `workspace:` or `catalog:`
  specifier in `dependencies` / `peerDependencies` / `optionalDependencies`
  (a `catalog:` in `devDependencies` is reported but allowed — npm never
  installs a published package's devDependencies; for the same reason a
  `workspace:*` devDependency on a **private** sibling is dropped from the
  packed manifest rather than failing the run)
- `README.md` or `LICENSE` is missing from the tarball
- the packed version does not match the repo version

### Via GitHub Actions

`claxedo-packages-release.yml` — `workflow_dispatch` with a `track` choice
(`all`, `helpers`, `runtime`, `apps`, `wakes`, `cli`), `npm_tag`, and a `dry_run` toggle that
defaults to **true**. Uses the existing `NPM_TOKEN` secret and `id-token:
write` for provenance. The same workflow runs `--track all --dry-run`
automatically on every push to `dev` (and on PRs) touching any public package
dir or the release tooling. There is no second publisher.

### Pre-publish gate

```bash
bun run --cwd packages/claxedo-server release:packages --track all --dry-run
```

This is the whole gate: sibling pins are `workspace:*`, no published version
has unreleased changes behind it, every package builds, packs, and its tarball
carries README.md, LICENSE and no `workspace:`/`catalog:` specifier. A version
already on npm is reported as skipped, so the dry run is safe to repeat after a
release.

## Post-publish verification

```bash
for name in \
  @claxedo/helpers \
  @claxedo/agent-event-runtime \
  @claxedo/agent-sdk-runtime \
  @claxedo/sandbox-contract \
  @claxedo/sandbox-manager \
  @claxedo/workspace-relay \
  @claxedo/workspace-relay-protocol \
  @claxedo/workspace-runtime \
  @claxedo/channels \
  @claxedo/connections \
  @claxedo/wakes \
  @claxedo/cli \
; do
  echo "$name -> $(npm view "$name" version 2>/dev/null || echo 'NOT FOUND')"
done
```

Expect `0.1.0` for `@claxedo/helpers`, `0.8.0` for the runtime track, `0.5.0`
for the apps track, `0.4.0` for `@claxedo/wakes`, and `0.1.0` for
`@claxedo/cli`. A line still showing the old version means either the
registry has not finished indexing (retry) or that package's publish failed and
must be re-run before anything downstream of it in the graph above.

`@claxedo/workspace-runtime` ships its own `scripts/verify-publish.ts`, wired
into both its `prepublishOnly` and the publisher's `verify:publish` step; it
cross-checks `package.json` exports against `docs/api-manifest.json` and does
not need to be invoked separately.

## Known issues, deliberately not fixed here

- `wakes` and `workspace-runtime` still carry `Copyright (c) 2025 opencode`
  in `LICENSE`; the other 11 read `Copyright (c) 2026 Claxedo`. Cosmetic, and a
  call for the owner rather than the release tooling.
- `packages/sandbox-manager/src/runtime-version.ts` pins
  `DEFAULT_WORKSPACE_RUNTIME_VERSION = "0.5.2"`, which is a **sandbox image
  tag**, not a package version. It intentionally does not track
  `workspace-runtime`'s npm version and must only move when an image is built
  and pushed at the new tag.
