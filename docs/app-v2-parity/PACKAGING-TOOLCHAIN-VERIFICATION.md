# Desktop plugin toolchain isolation

Worktree: `package-fix`, branch `v2/package-fix`, based on `c9d831972e`.

## Cause and ownership

`bundleClaxedoServer` staged the OpenCode SDK and then called
`stagePluginToolchain` with the same `node_modules` directory. The SDK inventory
requires zod 4.1.8. The plugin API requires 4.4.3; copying its declarations also
copied its package manifest over the SDK's manifest. Both macOS packaging
commands consequently failed their exact SDK inventory check. The benchmark
record and both failure logs are in the `bench-final` worktree under
`scratchpad/bench-final`.

The desktop now stages `@claxedo/plugin-build` as a separate bundled package.
Its compiler, esbuild, native binaries, plugin API source and Solid/zod
declarations live in that package's private `node_modules`, under:

```
Resources/node_modules/
  zod/                                      # SDK 4.1.8
  @claxedo/plugin-build/
    index.js                                # checker and builder
    package.json
    node_modules/
      @typescript/typescript-darwin-arm64/
      @esbuild/darwin-arm64/
      esbuild/
      @claxedo/plugin-api/
      solid-js/
      zod/                                  # plugin API 4.4.3
```

The daemon imports `@claxedo/plugin-build` through ordinary Node resolution.
The checker retains its own module location, so `createRequire(import.meta.url)`
resolves the private compiler and type roots. The plugin API's `manifest.ts`
then resolves private zod. Daemon and SDK callers cannot descend into this
private dependency directory. No runtime configuration, alternative resolver,
compatibility path or inventory exception was added. SDK staging and
verification are unchanged.

Zod is necessary: `@claxedo/plugin-api/src/index.ts` exports `manifest.ts`, which
imports zod and derives public manifest types from its schema. The API's
manifest pins zod **4.4.3**. The staging test removes those declarations and
observes a compiler failure even with `skipLibCheck`; these are `.ts` sources,
not declarations ignored by that option. Using the SDK's 4.1.8 would violate
the API's declared dependency.

## Regression coverage

`stage-plugin-toolchain.test.ts` bundles a daemon-style caller and executes it
under Node from a temporary staging directory with `NODE_PATH` removed. The
parent dependency tree contains conflicting zod and deliberately broken compiler,
Solid, esbuild and plugin API packages. The valid plugin passes; a numeric
sidebar label returns TS2322. Resolution assertions prove the daemon's zod
manifest stays unchanged and the API resolves its private 4.4.3. Removing
private zod fails the check.

## Verification ledger

All builds and test suites ran sequentially. Local raw logs and exact command
records are under `scratchpad/package-fix`. No push or existing-commit rewrite
was performed. No budget or inventory check was loosened.

The first broad-suite run found a separate inherited V2 failure: Mermaid's
`classDiagram-OUVF2IWQ-DelafidV.js` and
`classDiagram-v2-EOCWNBFH-DelafidV.js` were byte-identical. Both files in both
this worktree and `bench-final` had SHA-256
`7604a838bade8e7cbe3baafabde32fa5946151fa5659fadf240f5fb46c353006`.
V1 already grouped these entries; V2 discarded its manual chunk rules. The
existing grouping now has one owner, `desktopRendererChunk`, used by both
desktop renderer configurations. The duplicate-chunk test is unchanged.

The signal-safety prefix used below was:

```sh
sandbox-exec -f /private/tmp/claude-501/-Users-yashvardhansingh-test-opencode/b8fc7026-28c0-4b62-97e7-6646f6620b5a/scratchpad/nosignal.sb
```

| Working directory | Command (after that prefix for tests/typechecks, except Electron boundary) | Result |
| --- | --- | --- |
| Repository root | `bun -e 'import { buildPublishedPackages } from "./packages/claxedo-desktop/scripts/published-packages.ts"; await buildPublishedPackages(process.cwd(), console.log)'` (no prefix) | 14 build tasks passed |
| `packages/claxedo-desktop` | `CSC_IDENTITY_AUTO_DISCOVERY=false bun run package:mac -- --dir --publish never` (no prefix) | Passed, including strict SDK inventory |
| `packages/claxedo-desktop` | `CSC_IDENTITY_AUTO_DISCOVERY=false bun run package:mac:v2 -- --dir --publish never` (no prefix) | Passed, including strict SDK inventory |
| `packages/claxedo-plugin-build` | `bun run test` | 12 passed |
| `packages/claxedo-plugin-build` | `bun run typecheck` | Passed |
| `packages/claxedo-desktop` | `bun run test:bundle-single` | 3 passed |
| `packages/claxedo-desktop` | `bun run test:server-boot` | 6 passed |
| `packages/claxedo-desktop` | `bun run test:electron-boundary` (no prefix) | 16 passed |
| `packages/claxedo-desktop` | `bun run typecheck` | Passed |

The first `test:broad` result was 1,058 passed, 3 skipped, 1 failed (the
inherited Mermaid duplication described above). Final results follow below.

### Packaged V2 toolchain

From the repository root, after final V2 packaging:

```sh
sandbox-exec -f /private/tmp/claude-501/-Users-yashvardhansingh-test-opencode/b8fc7026-28c0-4b62-97e7-6646f6620b5a/scratchpad/nosignal.sb env -u NODE_PATH ELECTRON_RUN_AS_NODE=1 'packages/claxedo-desktop/dist/mac-arm64/Claxedo V2 Dev.app/Contents/MacOS/Claxedo V2 Dev' scratchpad/package-fix/packaged-toolchain-check.mjs
```

Exit 0. The probe imports the finished app's
`Contents/Resources/node_modules/@claxedo/plugin-build/index.js`, creates a
fixture importing `definePlugin`, and calls `checkPluginApp`, the implementation
used by `appPluginAuthoring.check` and the `app_plugin_check` MCP handler.
This reuses the prior lane's Node/staged-toolchain proof, now against an actual
packaged app and its Electron runtime. It does not import checkout plugin-build
code or use `NODE_PATH`.

- Valid sidebar label: `ok: true`, no diagnostics, bundle hash `d07a22ab377869bb`.
- Numeric sidebar label: `ok: false`, TS2322 at `src/app.tsx:1:131`.
- Restored label: `ok: true`, same bundle hash and no diagnostics.

`packaged-toolchain-check.log` contains the full results. The fixture is removed
on completion. The packaged SDK and API declaration versions were independently
read as 4.1.8 and 4.4.3 respectively.

A separate live daemon/MCP probe is prepared in
`scratchpad/package-fix/packaged-check.ts`. It has not run: this worktree was
not assigned `CLAXEDO_E2E_PORT_RANGE`, and the user's shared-Mac rules require an
assigned range for E2E stacks. The user was asked for that range. Once supplied,
run the probe sequentially under the same signal-safety prefix with
`env CLAXEDO_E2E_PORT_RANGE=<assigned-range> bun scratchpad/package-fix/packaged-check.ts`.
It uses the packaged daemon, an isolated HOME/data directory, and an ACP fixture
that receives the daemon's real session MCP credential; no model provider is
contacted. This live MCP boundary remains unverified by this run.

### Final checks

| Working directory | Command (with the signal-safety prefix above) | Result |
| --- | --- | --- |
| `packages/claxedo-desktop` | `bun run test:broad` | 1,059 passed, 3 skipped, 0 failed against final V2 output |
| `packages/claxedo-desktop` | `bun run typecheck` | Passed after the renderer change |
| Repository root | `bun run test:architecture-ratchets` | 13 tests and all 8 source-boundary policies passed; helper phase exited 1 on pre-existing findings |

Final packaging logs are `package-v1-final.log` and `package-v2-final.log`, both
exit 0. Final broad/typecheck logs are `desktop-broad-final.log` and
`desktop-typecheck-final.log`.

The helper phase still reports 4,235 findings and 4,148 duplicate copies.
`bun scratchpad/package-fix/helper-baseline.ts` reran the same scanner with
changed tracked files read from `git show HEAD:<path>` in memory, before any
commit (HEAD was `c9d831972e`). It wrote no source files and changed no baseline.
Comparison against `architecture-final.log`, ignoring source line numbers,
found **identical findings, zero new growth**. The machine-readable result is
`architecture-comparison.json`. `git diff --check` passed. No protected UI/V1
package was edited.
