# Embedded SDK Node cutover validation

Validated on 2026-09-05 in branch `codex/embedded-sdk-node-patch`, after
rebasing onto `eefd4a8777` from `origin/dev`.

## Delivered scope

- `workspace-runtime/src/opencode` owns the public beta-18684 embedded SDK.
  Consumers use `@claxedo/workspace-runtime/opencode`; the separate
  `@claxedo/opencode-runtime` package is removed.
- Legacy transfer/import code, the V2 proxy route, old HTTP-engine helpers and
  reverse compatibility-event conversion are removed. This is not a
  backward-compatible storage migration.
- Five exact-version patches support Node ESM, a real POSIX process lock via
  Koffi, and authoritative provider-disable policy. Desktop stages the patched
  package closure; npm and sandbox installs share the canonical patch runner.
- Runtime and release jobs use Node 24+. Electron stays at 43.2.0; no Bun
  runtime is bundled. Bun remains a build/development tool.
- Provider policy is persisted and workspace-scoped, concurrent provider
  updates are serialized, tool registrations enforce workspace ownership, and
  terminal SDK events route by session identity even when they omit location.
- Event-pump shutdown no longer leaves a rejected speculative read unobserved.

## Checks performed

Commands below are relative to the repository unless a package is specified.
All passed unless explicitly marked otherwise.

| Check | Command / entrypoint | Result |
| --- | --- | --- |
| Repository types | `bun run typecheck` | 37/37 packages |
| Import architecture | `bun run test:architecture-ratchets` | 8 policies; no ceiling increases |
| Runtime tests | In workspace-runtime: `bun test src/opencode src/routes/provider-config.test.ts src/workspace/runtime.test.ts src/workspace/session-access-policy.test.ts src/routes/session-core.test.ts src/routes/session-core.routes.test.ts src/session-route-inventory.guard.test.ts src/remote-session-authority.test.ts scripts/stage-opencode-sdk.test.ts scripts/stage-opencode-patches.test.ts` | 211 tests, 701 assertions |
| UI projections | In claxedo-app: `bun test --conditions=browser --preload ./happydom.ts src/app/providers/global-sdk/provider.test.ts` | 54 tests |
| Local-server integration | In claxedo-local-server: `node ./node_modules/vitest/vitest.mjs run src/deployments/local/embedded-workspace-runtime.test.ts src/opencode/mcp-sync.test.ts src/opencode/compat-routes/auth-dispose.test.ts` | 19 tests |
| Agent package API | In agent-sdk-runtime: `bun test src/public-api.test.ts src/architecture-ratchets.test.ts src/harnesses/harness-capabilities.test.ts` | 15 tests |
| Sandbox build | In claxedo-server: `node ./node_modules/vitest/vitest.mjs run scripts/sandbox/tests/build-sandbox-image.test.ts` | 16 tests |
| Desktop boot and package structure | In claxedo-desktop: `CLAXEDO_TEST_ELECTRON_EXECUTABLE=<Electron 43.2.0 binary> bun test scripts/claxedo-server-boot.test.ts scripts/package-structure.test.ts` | 18 tests |
| Node public entries | In workspace-runtime: `bun run test:opencode-node` (spawns Node, not Bun) | SDK and HTTP-host probes exit 0 on Node 26.8.1 |
| Electron public host | In workspace-runtime: `ELECTRON_RUN_AS_NODE=1 <Electron binary> scripts/node-host-smoke.mjs` | Exit 0 on Electron 43.2.0 / Node 24.18.0 |
| SDK patch installer | `node script/apply-dependency-patches.ts` | Exact forward/reverse checks pass |
| Publish contracts | `bun run --cwd packages/workspace-runtime verify:publish` and `bun run --cwd packages/agent-sdk-runtime verify:publish` | Both pass |
| Standalone local artifact | In claxedo-local-server: `bun run build && bun run smoke:build` | Built-entry smoke passes |
| Changed-file lint | `oxlint` against all 102 added/modified JS/TS files | 0 errors, 586 warnings |
| Whitespace | `git diff --check` | Pass |

### Linux real-entry validation

Generated the production `workspace-runtime-host.mjs`, dependency manifest,
patch files and installer using `bundleClaxedoWorkspaceRuntimeHost`.
In a clean Linux arm64 container, `npm install --min-release-age=2` applied
the patches and `node node-sdk-smoke.mjs` passed on Node 24.18.0.
This covers cross-process lock contention, release/reacquisition, invalid-fd
errors, location-dependent API calls and persisted sessions.

The production HTTP entry was then started under
`node:24.18.0-trixie-slim`. Session creation preserved the requested ID;
prompting a deliberately missing model produced a durable failed turn; the
message snapshot returned a valid event ordinal; the removed legacy route
returned 404. The process and smoke exited successfully.

Bookworm failed loading the existing better-sqlite3 13 arm64 prebuild because
it requires glibc 2.38. The standard sandbox Dockerfile now uses Trixie.
This tested the actual host bundle, not a full image containing every optional
terminal-agent CLI.

### Packaging cost

The staged macOS arm64 SDK closure contains 621 packages, no checkout
symlinks, and exactly one SDK/core/Koffi version. It is 326 MiB on disk and
54,886,400 bytes as a gzip tar, excluding the approximately 14.7 MB server
bundle. These are component measurements, not a signed installer size.

## Remaining release gates

- Release maintainer: run native/runtime checks on Windows, Linux x64 and
  macOS x64; this workstation validated macOS and Linux arm64 only.
- Release maintainer: build/run the Cloudflare base image and a signed final
  Electron installer. Neither was deployed or signed in this task.
- Provider integration owner: run a credentialed live-model turn. This
  continuation exercised real SDK/host entries and controlled provider
  failure, not a paid provider response.
- Repository lint owner: repair the unchanged Astro parsing failure at
  `packages/claxedo-web/src/components/ClaxedoStorm.astro:50`.
  `bun run lint` reports one error there; it is not caused by this diff.

Sequential inline review covered correctness, reliability, security, testing,
API contracts, simplification, frontend races and agent access. There were no
remaining actionable findings after fixes. Repository instructions required
main-task execution, so no independent or cross-model review is claimed.
Historical plan units are not all re-certified by this validation record.
