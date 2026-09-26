# Plugin-tools lane review and verification

Review date: 2026-09-26. Worktree: `opencode-app-v2-lanes/plugin-tools`, branch: `v2/plugin-tools`. Review fixes are committed in `1ba04969a0`. Integration `8b58832259` was merged in `9fe293ecd0`, then `feat/app-v2` at `b05be61886` (including the requested `38a728932c`) in `ff2024064c`. The latter merge retained the real session-row credential test instead of the incoming unavailable-route exception. No integration-checkout files were edited.

## Review findings and changes

1. **Owner relay traffic was denied.** The old grant treated every journal actor as a member. The control plane now supplies the enrollment owner's actor ID in the machine heartbeat. The daemon compares verified actor identity, not workspace role. The self-hosted composition additionally requires an operator-owned workspace.
2. **Journal-only ownership missed admitted queue/steer input.** `SessionAuthoringOwnership` records the verified actor transactionally with queue admission. It checks both those durable actors and `turn.start` journal actors through the full parent chain. Queue deletion, steering, restart, and missing ancestry cannot turn a member-driven session into an owner session.
3. **MCP visibility was captured too early.** A harness can establish its MCP connection while creating the session, before the runtime stores that session. Grants now evaluate current ownership. The registry refreshes visibility on every incoming message and authorizes every handler call, including the guide. Missing sessions are refused until they exist; old connections lose access when a member prompt is admitted.
4. **A member could create a fresh root through `session_create` or `task_start`.** Both tools now use the session-reach owner to refuse detached root creation by a member-driven session. Its error directs delegation through `subagent_spawn`, whose canonical parent preserves ancestry. Owner root/worktree/cloud placement is unchanged.
5. **OpenCode and Pi lacked first-party MCP wiring.** OpenCode's SDK tool transform and session-context filter now connect with each session's credential before execution. Pi's runtime extension receives the connection over its RPC pipe and registers the same MCP catalog before the turn. Both use one shared HTTP MCP transport. Pi marks its turn busy before asynchronous connection setup and retires failed setup through its existing turn cleanup. OpenCode tools explicitly opt out of the SDK's code-mode wrapper; the generated Pi connector is self-contained under Node/tsx and Bun.
6. **Filesystem errors were disguised as missing folders.** Authoring only handles ENOENT as absence, validates real paths, and rechecks the grant before mutations. Existing nonempty folders, registered IDs, and out-of-workspace paths are refused.
7. **Verification defects hid real results.** The desktop dependency scanner now parses actual imports instead of guide examples. Desktop packaging fixtures include their canonical build dependency and compile-cache manifest. Server credential tests provide the real host-token verifier and reject unauthorized publication. The subagent live test waits for its failed turn to settle. The native MCP runtime tests run serially in a fresh process because the broad suite replaces the global Response constructor. Storybook declares its two actual CSS imports. Flow 40 understands the installed Codex custom-tool protocol. E2E cleanup signals only its own child PIDs.

The four canonical tools are `app_plugin_create`, `app_plugin_check`, `app_plugin_add`, and `app_plugin_guide`. No executable `claxedo plugin` CLI, old authoring skill, or skill-launch helper remains. Current decision, plan, and handoff documentation use the tool contract.

## Ownership and timing

A relay request first passes verified ingress and session admission. The delivery owner writes the prompt and verified actor through `RuntimeStore.queuePrompt` in one transaction, before dispatch. `runRuntimePromptTurn` carries that actor and public author to the runtime; the runtime journals `turn.start` before harness execution. The credential identifies the session, not its right to author. Its MCP connection can predate the first user message; therefore neither credential-mint time nor the initial tool catalog is trusted as an ownership decision.

At tool-list and tool-call time, the daemon resolves the credential's workspace/session, reads current lineage ownership, and compares every admitted relay actor with the enrollment owner. A local owner has no relay actor; the owner's relay actor matches; a member actor never matches even with an organization-owner role. Unknown relay ownership and missing ancestors fail closed. This check also protects stale connections and descendants. Live tests assert refusal immediately after prompt admission, before waiting for the public author-stamped message projection.

`app_plugin_add` only registers and builds. The app still requires its existing in-app confirmation before executing the plugin. Flow 40 proves the sidebar item is absent before confirmation and the plugin page renders afterward. Paths are restricted to the session workspace after real-path resolution.

## Harness and packaged evidence

| Harness | Production owner | Real-entrypoint evidence |
| --- | --- | --- |
| Claude Code | Existing native MCP launch configuration | Flow 40 create, red/green check, add, confirmation, outside-path refusal |
| Codex | Existing thread MCP configuration | Guide invoked through the installed app-server's `functions.exec` custom-tool protocol |
| OpenCode | `workspace-runtime/src/opencode/first-party-mcp.ts` | Native SDK test plus web/phone flow; concurrent owner/member catalog and credential isolation test |
| Pi | `agent-sdk-runtime/src/harnesses/pi/first-party-mcp.ts` | Native executable test plus web/phone flow, including Node/tsx extension execution |

`app_plugin_guide` supplies the guide across all four harnesses; there is no harness-specific authoring skill installation.

The desktop toolchain stages esbuild, the platform-native TypeScript compiler, Solid/zod declarations, and plugin API source. `stage-plugin-toolchain.test.ts` bundles the checker and executes it under Node from a temporary staged package layout, with `NODE_PATH` removed. It builds the valid plugin and reports TS2322 for the invalid plugin. This verifies the packaged daemon's toolchain layout on this Mac; a distributable installer was not built.

## Verification

The implementation verified is merge `ff2024064c`. All runs were sequential. Detailed logs and the exact argv/cwd/exit-code ledger are local under `.artifacts/plugin-tools-review/merged-results.jsonl` and `merged-*.log`.

Every command below except `test:electron-boundary` was prefixed with:

```sh
sandbox-exec -f /private/tmp/claude-501/-Users-yashvardhansingh-test-opencode/b8fc7026-28c0-4b62-97e7-6646f6620b5a/scratchpad/nosignal.sb
```

The Electron boundary stage uses its own Chromium sandbox; nesting it under the macOS profile prevents Chromium from launching. All runtime and process-ownership suites used the required profile. The server suite used its HOME-isolating `bun run test` entrypoint. No tests ran concurrently with another package suite or E2E stack.

| Working directory | Command | Result |
| --- | --- | --- |
| Each of `packages/{claxedo-plugin-build,claxedo-mcp,claxedo-local-server,workspace-runtime,agent-sdk-runtime,claxedo-desktop,claxedo-server,session-ui,ui,claxedo-app-v2,storybook}` | `bun run typecheck` | All 11 passed |
| Repository root | `bun run typecheck --concurrency=1 --continue=always` | 35/36 tasks passed; V1 theme-token lint failed on the old app's unchanged `src/app/styles/index.css:363` and `:381` (deleted at the swap) |
| `packages/agent-sdk-runtime` | `bun run build` | Passed |
| `packages/claxedo-plugin-build` | `bun run test` | 12 passed |
| `packages/claxedo-mcp` | `bun run test` | 225 passed |
| `packages/claxedo-local-server` | `bun run test` | 851 passed, 1 failed: module budget 110 > 109; all 5 owner/relay live tests passed |
| `packages/workspace-runtime` | `bun run test` | Main: 1,572 passed, 4 skipped; relay: 42 passed; isolated MCP: 2 passed, 1 opt-in Pi skip; Node: 127 passed, 2 skipped |
| `packages/agent-sdk-runtime` | `bun run test` | 1,207 passed, 13 skipped |
| `packages/session-ui` | `bun run test` | 352 passed |
| `packages/ui` | `bun run test` | 127 passed |
| `packages/claxedo-app-v2` | `bun run test` | 183 passed |
| `packages/storybook` | `bun run test` | 8 passed |
| `packages/claxedo-desktop` | `bun run test:broad` | 1,057 passed, 3 skipped, including both staged-toolchain tests |
| `packages/claxedo-desktop` | `bun run test:bundle-single` | 3 passed |
| `packages/claxedo-desktop` | `bun run test:server-boot` | 6 passed |
| `packages/claxedo-desktop` | `bun run test:electron-boundary` | 16 passed |
| `packages/claxedo-app-v2` | `bun run typecheck:e2e` | Passed |
| `packages/claxedo-app-v2` | `bun run build` | Passed |
| `packages/claxedo-app-v2` | `bun run check` | All 21 checks passed |
| `packages/workspace-runtime` | `env CLAXEDO_TEST_NATIVE_PI=1 PI_EXECUTABLE=/Users/yashvardhansingh/test/opencode-app-v2-lanes/plugin-tools/packages/agent-sdk-runtime/.artifacts/pi/node_modules/.bin/pi bun run test:first-party-mcp` | All 3 native harness/isolation tests passed, including Pi |
| `packages/claxedo-app-v2` | `env CLAXEDO_E2E_PORT_RANGE=47900-47999 bunx playwright test e2e/flows/40-app-plugin-tools --workers=1` | Three successive runs passed: each 8 passed, 2 existing phone skips |
| Repository root | `bun run test:architecture-ratchets` | Retirement/build tests: 13 passed; 7 product boundaries passed; local-server failed at 82 modules > 80 |
| Repository root and integration checkout, read-only | `bun script/helpers/verify.ts` | Same 4,235 findings and 4,148 duplicate copies in both; findings identical after source line numbers are removed, with no new growth |
| `packages/claxedo-local-server` | `bun run verify:closure` | Failed at source closure 82 > 80; emitted/isolation stages were not reached |
| `packages/claxedo-server` | `bun run test` | 3,371 passed, 3 skipped across 313 files; Cloudflare worker: 32 passed |

`git diff --check` passed. The requested integration commit `38a728932c` is an ancestor of the verified merge. The integration checkout remained clean. No files in `packages/claxedo-app`, `packages/session-ui`, or `packages/ui` were edited during this review; the latter two contain changes inherited from the lane's original commits.

### Unmet gates

- **Lane closure budgets:** the desktop source path `src/self-hosted-execution.ts` / `app/local-app.ts` reaches the new `plugins/authoring.ts`, which reaches `plugins/scaffold.ts` and the existing service/build owners. These are intentional authoring and scaffold responsibilities, not accidental hosted imports. The source closure is 82/80; all published local modules measure 110/109 after deleting the old launch helper. Package counts remain within their existing limits. The inherited lane's ceiling increases were reverted. The lane/architecture owner must resolve this module growth before acceptance; neither ceiling was loosened or hidden behind an opaque import.
- **Root typecheck:** the V1 owner must replace the two existing CSS literals with canonical theme tokens. V1 is outside this task's permitted edit scope, so those declarations remain unchanged.
- **Existing helper divergence:** excluded from lane failures as requested; verified to have no growth. The helper baseline was not changed.
