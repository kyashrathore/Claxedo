# Publish order

Dependency-ordered publish sequence for the 13 public `@claxedo/*` packages,
derived from the actual `dependencies` in each `packages/*/package.json`.

- **Re-derived:** 2026-07-28
- **Previous release:** 2026-07-20 14:12–14:13 UTC (`0.6.0` / `0.3.0` / `0.2.0`)

`packages/claxedo-server` is `"private": true` and is **not** published; it is
the workspace that hosts the release tooling, nothing more.

## Version scheme

Three version tracks. Packages on a track move together, one step at a time —
this is what the tooling already encodes (`publish-runtime-packages.ts` stamps
one `--version` across its whole family) and what the last two releases did.
The cost is that a package with no content change still gets a bump; the
benefit is that a cross-pin is always "the same number", which is the class of
mistake that has actually bitten this repo.

| Track | Packages | Previous | This release |
|---|---|---|---|
| runtime | `agent-event-runtime`, `agent-extensions`, `agent-sdk-runtime`, `sandbox-contract`, `sandbox-manager`, `workspace-relay`, `workspace-relay-protocol`, `workspace-runtime` | 0.6.0 | **0.7.0** |
| apps | `channels`, `connections`, `mcp`, `workgraph` | 0.3.0 | **0.4.0** |
| wakes | `wakes` | 0.2.0 | **0.3.0** |

Each track moved a **minor** because at least one package on it added public
API since the previous publish:

- runtime — `agent-sdk-runtime` added `bundledAcpBinary` and the
  `observeAgentProcess` surface, and dropped the `@openai/codex` /
  `@zed-industries/claude-agent-acp` runtime dependencies; `workspace-runtime`
  added `createProcessObserver`, `WorkspaceWorktreeManager`,
  `workspaceStorageRoot` and eleven types (`docs/api-manifest.json` moved with
  it); `sandbox-manager` added the `./checkpoint-manager` and `./drivers/exe`
  export subpaths.
- apps — `workgraph` added `drainReadyStreams` to the SQLite store and service
  results and moved `better-sqlite3` 12.10.0 → 13.0.1 (a native-ABI major);
  `mcp` registered a new cloud-workspace tool set.
- wakes — `better-sqlite3` 12.10.0 → 13.0.1.

Riding their track with no shipped-content change of their own:
`agent-extensions`, `workspace-relay-protocol`, `channels` (test-script only),
`workspace-relay` and `connections` (source comments only).
`agent-event-runtime` earned a patch on its own (`@anthropic-ai/claude-agent-sdk`
0.3.210 → 0.3.215) and rides the track to minor.

## Dependency graph (`@claxedo/*` edges only)

```
Tier 0 — no @claxedo/* dependencies
  agent-event-runtime
  agent-extensions
  workspace-relay-protocol
  sandbox-contract
  channels
  connections
  workgraph
  wakes

Tier 1
  sandbox-manager    -> sandbox-contract
  agent-sdk-runtime  -> agent-event-runtime
  workspace-relay    -> workspace-relay-protocol

Tier 2
  workspace-runtime  -> agent-extensions, agent-sdk-runtime,
                        agent-event-runtime, workspace-relay,
                        workspace-relay-protocol

Tier 3
  workgraph          -> workspace-runtime

Tier 4
  mcp                -> workgraph
```

`sandbox-manager` depends on the dependency-neutral `sandbox-contract`, while
its former `workspace-runtime` pin was replaced by a constant in
`src/runtime-version.ts`. The contract therefore publishes in tier 0 and the
manager follows in tier 1.

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
than a number typed at release time. `--track` accepts `all`, `others`
(the seven the runtime workflow does not cover), `runtime-family`, or a version
track name (`runtime`, `apps`, `wakes`). `--packages a,b` selects by name or
directory. `--tag` sets the dist-tag (default `latest`); `--no-provenance`
disables provenance.

It refuses to publish when any of these is true, per package:

- a `@claxedo/*` dependency pin does not equal that package's in-repo version
- the package is `"private": true`
- `npm run build` or a package's own `verify:publish` fails
- the **packed** `package.json` still carries a `workspace:` or `catalog:`
  specifier in `dependencies` / `peerDependencies` / `optionalDependencies`
  (a `catalog:` in `devDependencies` is reported but allowed — npm never
  installs a published package's devDependencies)
- `README.md` or `LICENSE` is missing from the tarball
- the packed version does not match the repo version

### Via GitHub Actions

- `claxedo-packages-release.yml` — `workflow_dispatch` with a `track` choice,
  `npm_tag`, and a `dry_run` toggle that defaults to **true**. Uses the
  existing `NPM_TOKEN` secret and `id-token: write` for provenance. The same
  workflow runs `--track others --dry-run` automatically on every push to `dev`
  (and on PRs) touching those seven package dirs or the release tooling.
- `claxedo-runtime-release.yml` — the older, narrower path: the six-package
  runtime family only, with the version passed as a workflow input, which it
  writes into the package.json files as a side effect. Kept because it is
  already wired and tested. Prefer `claxedo-packages-release.yml`.

### Pre-publish gate

```bash
script/publish-preflight.sh            # all 13
script/publish-preflight.sh workgraph  # a subset, by packages/<dir> name
```

`publish-preflight.sh` is the **pre-publish** gate: on top of the checks above
it fails when a package's local version already exists on npm (i.e. the bump is
missing). That makes it wrong to run *after* a publish — the publisher's own
npm-view check is the idempotent one. Expect 13/13 PASS immediately before a
release.

## Post-publish verification

```bash
for name in \
  @claxedo/agent-event-runtime \
  @claxedo/agent-extensions \
  @claxedo/agent-sdk-runtime \
  @claxedo/sandbox-contract \
  @claxedo/sandbox-manager \
  @claxedo/workspace-relay \
  @claxedo/workspace-relay-protocol \
  @claxedo/workspace-runtime \
  @claxedo/mcp \
  @claxedo/channels \
  @claxedo/connections \
  @claxedo/wakes \
  @claxedo/workgraph \
; do
  echo "$name -> $(npm view "$name" version 2>/dev/null || echo 'NOT FOUND')"
done
```

Expect `0.7.0` for the runtime track, `0.4.0` for the apps track, and `0.3.0`
for `@claxedo/wakes`. A line still showing the old version means either the
registry has not finished indexing (retry) or that package's publish failed and
must be re-run before anything downstream of it in the graph above.

`@claxedo/workspace-runtime` ships its own `scripts/verify-publish.ts`, wired
into both its `prepublishOnly` and the publisher's `verify:publish` step; it
cross-checks `package.json` exports against `docs/api-manifest.json` and does
not need to be invoked separately.

## Known issues, deliberately not fixed here

- All 13 `LICENSE` files still read `Copyright (c) 2025 opencode`. Cosmetic,
  and a call for the owner rather than the release tooling.
- `packages/sandbox-manager/src/runtime-version.ts` pins
  `DEFAULT_WORKSPACE_RUNTIME_VERSION = "0.5.2"`, which is a **sandbox image
  tag**, not a package version. It intentionally does not track
  `workspace-runtime`'s npm version and must only move when an image is built
  and pushed at the new tag.
