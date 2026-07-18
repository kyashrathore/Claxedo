# Publish order

Dependency-ordered `npm publish` sequence for the 12 `@claxedo/*` packages in
this release, derived from the actual `dependencies` in each
`packages/*/package.json` (checked 2026-07-18; re-derive if the graph
changes).

Version scheme for this release:

- `@claxedo/{agent-event-runtime, agent-extensions, agent-sdk-runtime, sandbox-manager, workspace-relay, workspace-relay-protocol, workspace-runtime}` → `0.5.2`
- `@claxedo/{mcp, channels, connections, workgraph}` → `0.2.0`
- `@claxedo/wakes` stays `0.1.0` (first publish — `npm view @claxedo/wakes version` 404s today)

Run `script/publish-preflight.sh` before every step below and do not publish
a package until it shows `PASS`.

## Dependency graph (this release only, `@claxedo/*` edges)

```
agent-event-runtime         (no @claxedo deps)
agent-extensions             (no @claxedo deps)
workspace-relay-protocol     (no @claxedo deps)
claxedo-channels              (no @claxedo deps)
claxedo-connections           (no @claxedo deps)
wakes                        (no @claxedo deps)
workgraph                    (no @claxedo deps)

agent-sdk-runtime      -> agent-event-runtime
workspace-relay         -> workspace-relay-protocol
claxedo-mcp              -> workgraph

workspace-runtime -> agent-extensions, agent-sdk-runtime, agent-event-runtime,
                      workspace-relay, workspace-relay-protocol, workgraph

```

`sandbox-manager` has no `@claxedo/*` dependencies (the former
`workspace-runtime` pin existed only to stamp sandbox image tags and was
replaced by a constant in `src/runtime-version.ts`), so it can publish in
Tier 1 alongside the other leaf packages.

## Publish sequence

Run each package's command from the repo root, in this order. Every package
already pins its `@claxedo/*` dependencies to exact versions (checked via
`script/publish-preflight.sh`'s workspace:/catalog: check) — no package in
this release currently needs `bun publish` to resolve a `workspace:`
specifier. **Before running the batch, re-run
`script/publish-preflight.sh claxedo-mcp` and confirm its
`workspace:/catalog: specifiers` line still says `ok`** — `@claxedo/mcp`'s
dependency on `@claxedo/workgraph` was a live `workspace:0.1.0` specifier
earlier in this session and was converted to an exact `0.2.0` pin mid-session;
if it (or any other package) ever regresses back to a `workspace:` or
`catalog:` specifier in `dependencies`, publish that package with
`bun publish` instead of `npm publish` — `bun publish` resolves and rewrites
`workspace:`/`catalog:` specifiers to real versions before packing; plain
`npm publish` does not, and republishes the raw protocol string as-is
(the cause of the earlier `EUNSUPPORTEDPROTOCOL` install failure).

### Tier 0 — no `@claxedo/*` dependencies (any order)

```bash
cd packages/agent-event-runtime && npm publish && cd -
cd packages/agent-extensions && npm publish && cd -
cd packages/sandbox-manager && npm publish && cd -
cd packages/workspace-relay-protocol && npm publish && cd -
cd packages/claxedo-channels && npm publish && cd -
cd packages/claxedo-connections && npm publish && cd -
cd packages/wakes && npm publish && cd -
cd packages/workgraph && npm publish && cd -
```

### Tier 1 — depend on one Tier 0 package

```bash
cd packages/agent-sdk-runtime && npm publish && cd -    # needs @claxedo/agent-event-runtime on npm
cd packages/workspace-relay && npm publish && cd -      # needs @claxedo/workspace-relay-protocol on npm
cd packages/claxedo-mcp && npm publish && cd -           # needs @claxedo/workgraph on npm
```

### Tier 2 — depends on five Tier 0/1 packages

```bash
cd packages/workspace-runtime && npm publish && cd -
# needs @claxedo/agent-extensions, @claxedo/agent-sdk-runtime,
# @claxedo/agent-event-runtime, @claxedo/workspace-relay,
# @claxedo/workspace-relay-protocol, @claxedo/workgraph all on npm first
```

All 12 packages have `"publishConfig": { "access": "public" }` in their
`package.json`, so a plain `npm publish` is sufficient — no `--access public`
flag needed.

## Post-publish verification

After each tier (or after the full batch), confirm every published name
actually resolved to the new version on the registry:

```bash
for name in \
  @claxedo/agent-event-runtime \
  @claxedo/agent-extensions \
  @claxedo/agent-sdk-runtime \
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

Expect every line to show the new version from the version scheme above
(`0.5.2` / `0.2.0`, `@claxedo/wakes` at `0.1.0`). If any line still shows the
old version, the registry hasn't finished indexing yet (retry after a few
seconds) or the publish for that package failed and must be re-run before
anything downstream of it (see the dependency graph above) is published.

`@claxedo/workspace-runtime` also ships its own
`packages/workspace-runtime/scripts/verify-publish.ts`, wired into that
package's `prepublishOnly`, which cross-checks its `package.json` exports
against `docs/api-manifest.json`; it runs automatically as part of
`npm publish` for that package and does not need to be invoked separately.
