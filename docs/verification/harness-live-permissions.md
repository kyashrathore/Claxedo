# Permission changes on running harnesses

Verified 2026-10-02.

| Harness transport | Application timing | Native mechanism |
| --- | --- | --- |
| Claude SDK | Immediate after native acknowledgement | Streaming `Query.setPermissionMode()` |
| ACP, including custom agents exposing modes | Immediate after peer response | `session/set_config_option` or `session/set_mode` |
| Codex app-server | Next turn | Active-turn API does not accept permission changes |
| Cursor SDK | Next turn | Sandbox and review options belong to agent creation/resumption |
| Pi RPC | Unsupported | No session permission modes |
| OpenCode SDK | Unsupported | No session permission-mode API |

## Claude flow and change

Before this change, selecting a mode called `ClaudeSdkTransport.config.setPermissionMode()`, which only validated the mode. The runtime persisted it, but the running native query never received a control message. Launches and reused prompts read the runtime's saved configuration later.

Now:

1. The picker calls `PUT /session/:id/permission-mode` in `session-core/src/routes/session-core.ts`. The route checks session authority, capabilities and permission ceilings.
2. `createHarnessReads().keepPermissionMode()` in `session-core/src/host/config-ops.ts` calls the attached transport's setter before persisting or publishing a selection.
3. `ClaudeSdkTransport.config.setPermissionMode()` validates the mode and calls the session's existing `ClaudeLiveQuery.setPermissionMode()` when there is a live query.
4. `ClaudeLiveQuery` serializes that control with reused-prompt settings. If the query is launching, the control waits until the native SDK stream exists. `applyClaudePermissionMode()` sends `Query.setPermissionMode()` and updates the live snapshot only after acknowledgement. Native status mode changes refresh the same snapshot.
5. A native refusal throws a typed configuration error with its cause; the runtime does not save or publish the requested mode. A later control can recover without replacing the process.
6. After success, the runtime persists the returned mode and publishes its session update. The response and picker delivery metadata preserve `appliesFrom: immediate` through the wire decoder.

Claude requires `allowDangerouslySkipPermissions` at launch to permit a later live bypass selection. Launches provision that capability only when the session's permission ceiling permits full access. The selected native mode and explicit deny rules still govern tools. Tightening uses the same live control.

## ACP flow

`acpConfig().setPermissionMode()` already calls `acpSetPermissionMode()` immediately without waiting for the active prompt to complete. Config-option responses supply the agent's current options; the modes channel supplies its native mode updates. `acpPermissionModes()` now reports immediate timing for both supported mode surfaces. Unsupported surfaces retain their unsupported report. The peer remains authoritative for its own permission behavior.

ACP explicitly permits changing modes while an agent generates a response: [session modes](https://agentclientprotocol.com/protocol/v1/session-modes). Claude documents dynamic mode changes for streaming sessions: [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

## Acceptance checks

Commands below ran from the named package. `bun` was invoked through `/Users/yashvardhansingh/.bun/bin/bun`; script commands added its directory to PATH.

| Location | Command | Result |
| --- | --- | --- |
| harness | `bun test src/conformance/claude.test.ts -t 'Claude applies permission changes'` before implementation | Expected failure: active turn still asked permission |
| harness | `bun run flows H10-config-timing` | Passed outside the execution sandbox: public HTTP setter changes the active turn, Codex next-turn settings apply, credential renewal works, child permission widening is rejected |
| harness | `bun test src/conformance/claude.test.ts -t 'floor\|active turn\|permission mode set'` | 12 passed, including live relaxation, live tightening and deny-floor checks in every mode |
| harness | `bun test src/conformance/acp.test.ts -t 'permission mode\|turn.s permission mode'` | 5 passed, including both mode-update protocols during an active prompt and native clamping refusal |
| harness | `bun test src/transports/claude-sdk src/transports/acp/protocol.test.ts src/transports/codex-app-server/modes.test.ts src/transports/cursor-sdk/permission-modes.test.ts` | 226 passed |
| harness | `bun test src/transports/claude-sdk/live-permissions.test.ts src/transports/claude-sdk/live-settings.test.ts src/transports/claude-sdk/permissions.test.ts` | 15 passed after the final helper change; launch waiting, acknowledgement, ordering, refusal recovery and native mode moves covered |
| session-core | `bun test src/host/config-ops.test.ts src/routes/session-children.routes.test.ts` | 59 passed |
| session-core | `bun test src/host/config-ops.test.ts` after adding native-refusal persistence coverage | 9 passed |
| agent-runtime-contract | `bun test src/harness-table.test.ts` | 22 passed |
| claxedo-app | `bun test --conditions browser src/composer/permission src/server/wire/permission-modes.test.ts` | 8 passed; unknown timing is refused rather than synthesized |
| harness and claxedo-app | `bun run typecheck` | Both passed |
| repository root | `bun run test:architecture-ratchets` | 26 tests passed; all six boundary policies, helpers and file-size ratchets passed |
| repository root | `git diff --check` | Passed |

The HTTP flow could not spawn Claude inside the agent execution sandbox. The same flow passed outside it, so the public-entrypoint acceptance criterion is verified.

`bun run check` remains blocked by six domain budgets already exceeded at HEAD: profiles 654/600, ACP 3070/3014, Claude 3327/2969, Codex 3057/2793, Cursor 1865/1652 and Pi 1397/864. This change adds 29 Claude production lines. Other concurrent work also changes ACP and Pi totals. No budget ceilings were raised. The owner is the harness package; the follow-up is a separate responsibility review and reduction of the existing over-budget domains.

Codex's upstream limitation remains documented in [the native reproduction](codex-live-permissions.md). No transport answers or auto-grants a broker request as a substitute for a native permission control.
