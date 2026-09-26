# Plugin-tools lane review and verification

Review date: 2026-09-26. Worktree: `opencode-app-v2-lanes/plugin-tools`, branch: `v2/plugin-tools`. Integration `8b58832259` was merged without conflicts in `9fe293ecd0`; no integration-checkout files were edited.

## Review findings and changes

1. **Owner relay traffic was denied.** The old grant treated every journal actor as a member. The control plane now supplies the enrollment owner's actor ID in the machine heartbeat. The daemon compares verified actor identity, not workspace role. The self-hosted composition additionally requires an operator-owned workspace.
2. **Journal-only ownership missed admitted queue/steer input.** `SessionAuthoringOwnership` records the verified actor transactionally with queue admission. It checks both those durable actors and `turn.start` journal actors through the full parent chain. Queue deletion, steering, restart, and missing ancestry cannot turn a member-driven session into an owner session.
3. **MCP visibility was captured too early.** A harness can establish its MCP connection while creating the session, before the runtime stores that session. Grants now evaluate current ownership. The registry refreshes visibility on every incoming message and authorizes every handler call, including the guide. Missing sessions are refused until they exist; old connections lose access when a member prompt is admitted.
4. **A member could create a fresh root through `session_create` or `task_start`.** Both tools now use the session-reach owner to refuse detached root creation by a member-driven session. Its error directs delegation through `subagent_spawn`, whose canonical parent preserves ancestry. Owner root/worktree/cloud placement is unchanged.
5. **OpenCode and Pi lacked first-party MCP wiring.** OpenCode's SDK tool transform and session-context filter now connect with each session's credential before execution. Pi's runtime extension receives the connection over its RPC pipe and registers the same MCP catalog before the turn. Both use one shared HTTP MCP transport. Pi marks its turn busy before asynchronous connection setup and retires failed setup through its existing turn cleanup. OpenCode tools explicitly opt out of the SDK's code-mode wrapper; the generated Pi connector is self-contained under Node/tsx and Bun.
6. **Filesystem errors were disguised as missing folders.** Authoring only handles ENOENT as absence, validates real paths, and rechecks the grant before mutations. Existing nonempty folders, registered IDs, and out-of-workspace paths are refused.
7. **Verification defects hid real results.** The desktop dependency scanner now parses actual imports instead of guide examples. Desktop packaging fixtures include their canonical build dependency and compile-cache manifest. Server credential tests provide the real host-token verifier and reject unauthorized publication. The subagent live test waits for its failed turn to settle. Storybook declares its two actual CSS imports. Flow 40 understands the installed Codex custom-tool protocol. E2E cleanup signals only its own child PIDs.

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

Results are recorded below after the final sequential run. Detailed logs are local under `.artifacts/plugin-tools-review/`.
