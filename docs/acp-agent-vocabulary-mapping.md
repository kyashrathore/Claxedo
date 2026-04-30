# ACP Agent Vocabulary Mapping — Exhaustive Reference

Complete per-agent inventory of ACP surface, cross-referenced against the SDK
spec and our adapter's handling. Every row cites source. Every silent drop and
every unhandled capability is flagged.

> **Status.** Compiled 2026-04-24 from full source reads of the three adapter
> repos, the SDK schema, the Cursor docs, and our adapter code. Confidence
> column per row: `SRC` (agent source read), `SPEC` (SDK schema / d.ts),
> `DOCS` (vendor docs only), `CODE` (our code). Treat `DOCS` rows as less
> reliable than `SRC`/`CODE` until traces verify them.

---

## Table of contents

1. [Pinned versions & confidence legend](#1-pinned-versions--confidence-legend)
2. [At-a-glance divergence](#2-at-a-glance-divergence)
3. [ACP method coverage matrix](#3-acp-method-coverage-matrix)
4. [SessionUpdate variant coverage matrix](#4-sessionupdate-variant-coverage-matrix)
5. [ToolCallContent + ContentBlock coverage](#5-toolcallcontent--contentblock-coverage)
6. [Enums — ToolKind, ToolCallStatus, StopReason, PermissionOptionKind](#6-enums)
7. [Capabilities negotiation](#7-capabilities-negotiation)
8. [Claude — exhaustive vocabulary](#8-claude--exhaustive-vocabulary)
9. [Codex — exhaustive vocabulary](#9-codex--exhaustive-vocabulary)
10. [Cursor — exhaustive vocabulary](#10-cursor--exhaustive-vocabulary)
11. [Our adapter — complete rule inventory](#11-our-adapter--complete-rule-inventory)
12. [Our translator — complete case enumeration](#12-our-translator--complete-case-enumeration)
13. [Permission & approval models — side-by-side](#13-permission--approval-models--side-by-side)
14. [Interactive state & recovery semantics](#14-interactive-state--recovery-semantics)
15. [Complete silent-drop inventory](#15-complete-silent-drop-inventory)
16. [Known bugs and partial implementations](#16-known-bugs-and-partial-implementations)
17. [Unused agent capabilities we could exploit](#17-unused-agent-capabilities-we-could-exploit)
18. [rawInput/rawOutput field-name drift per agent](#18-rawinputrawoutput-field-name-drift-per-agent)
19. [Prioritized gaps roadmap](#19-prioritized-gaps-roadmap)
20. [How to keep this honest](#20-how-to-keep-this-honest)
21. [Sources](#21-sources)

---

## 1. Pinned versions & confidence legend

| Component              | Version / ref       | Source confidence |
| ---------------------- | ------------------- | ----------------- |
| ACP spec SDK           | `@agentclientprotocol/sdk@0.16.1` | SPEC |
| Claude adapter         | `agentclientprotocol/claude-agent-acp@0.22.1` (TypeScript, 3,871 lines) | SRC |
| Codex adapter          | `zed-industries/codex-acp@0.10.0` (Rust, 6,606 lines) | SRC |
| Cursor agent           | `agent` binary (closed source) | DOCS |
| Our ACP adapter        | `packages/workspace-runtime/src/adapters/acp*` (4,216 lines) | CODE |
| Verification date      | 2026-04-24          | — |

Confidence legend in tables:
- **SRC** — verified against the agent's own source code.
- **SPEC** — verified against the SDK JSON Schema (`schema.json`) or `acp.d.ts`.
- **DOCS** — from vendor docs only, not source — may be incomplete or stale.
- **CODE** — verified against our adapter code.
- **—** — not applicable or not determinable from available sources.

---

## 2. At-a-glance divergence

The three agents differ fundamentally in **how** they produce ACP events, not
just in what they name things:

| Dimension                  | Claude                                             | Codex                                                | Cursor                                              |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Tool model                 | **Named tools with stable vocabulary** (12 tools)  | **No tool vocabulary** — `EventMsg` enum translated to synthesized tool_calls | **Client capabilities + 5 `cursor/*` methods**    |
| Plan / todos               | `TodoWrite` tool → emits `plan` SessionUpdate (skips tool_call pipeline) | `update_plan` → native `plan` SessionUpdate | `cursor/update_todos` extension (has `merge` flag) |
| Subagents                  | `Task` / `Agent` tool — inner events tagged `_meta.claudeCode.parentToolUseId`, **not** embedded | No first-class concept; partial `CollabAgent*` events exist but all silently dropped | `cursor/task` extension method — 8-variant `subagentType` enum (incl. `{custom: string}`) |
| Permission kinds           | Single `requestPermission` path, 3–5 options depending on mode | **Four distinct** approval flows: exec, patch, MCP elicitation, RequestPermissions | Single `session/request_permission`; 3 outcomes documented |
| Questions to user          | None natively (disallows `AskUserQuestion` tool with "in progress" comment) | None natively | `cursor/ask_question` extension (blocking, supports multi-select) |
| Plan approval              | `ExitPlanMode` tool + 5-option permission prompt | `ApplyPatchApprovalRequest` per-patch | `cursor/create_plan` extension (blocking) with `planUri` returned |
| Image generation           | Not a tool                                         | `ViewImageToolCall` (viewing, not generating)        | `cursor/generate_image` extension (notification) |
| Session modes              | `auto` / `default` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions` | Approval presets (`read-only` etc) from `APPROVAL_PRESETS` | `agent` / `plan` / `ask` (docs name these but `set_mode` not documented) |
| Session config options     | `mode`, `model`, `effort` (3 IDs)                  | `mode`, `model`, `reasoning_effort` (3 IDs)          | Not documented                                      |
| Custom `_meta` extensions  | `_meta.claudeCode.*` + `_meta["terminal-auth"]` + `_meta.terminal_{info,output,exit}` on tools | `client_capabilities.meta.terminal_output` flag controls rendering | Not documented                                      |
| ACP methods declared       | 14 methods (5 with `unstable_` prefix)             | 12 methods (`list_sessions`, `logout`, `close_session` all present) | 8 standard ACP methods + 5 `cursor/*` extensions |

**Central insight.** The RFC #1064 transport work is additive — the protocol
*shape* is stable across agents because the SDK enforces it. The brittleness
lives one level below, in the per-agent vocabularies (tool names, `rawInput`
field shapes, `_meta` namespaces, approval taxonomies). Anything translator
code reaches for inside `rawInput` / `rawOutput` / `_meta.*` is agent-specific
and version-specific.

---

## 3. ACP method coverage matrix

Rows are every ACP method in the SDK schema, plus agent-specific extensions.
Columns show whether each agent implements it on the server side, whether our
adapter calls it on the client side, and notes. **UNSTABLE** means marked so
in SDK 0.16.1 — even if the method has since stabilized (e.g. `session/resume`
2026-04-22, `session/close` 2026-04-23), the SDK type name still carries
`unstable_` prefix in `acp.d.ts`.

| Method                            | Direction     | SDK status  | Claude 0.22.1 | Codex 0.10.0 | Cursor (docs) | Our adapter calls | Conf |
| --------------------------------- | ------------- | ----------- | ------------- | ------------ | ------------- | ----------------- | ---- |
| `initialize`                      | C→A           | stable      | yes (ac-agent:364) | yes (L403) | yes (docs) | yes (acp.ts:429) | SRC/SRC/DOCS/CODE |
| `authenticate`                    | C→A           | stable      | yes (gateway-only, others throw) | yes (ChatGpt/API key) | yes (`cursor_login`) | partial — we use env vars pre-auth | SRC/SRC/DOCS/CODE |
| `session/new`                     | C→A           | stable      | yes (ac-agent:496) | yes (L517) | yes (docs) | yes | SRC/SRC/DOCS/CODE |
| `session/load`                    | C→A           | stable      | yes (ac-agent:537) | yes (L571) | yes (docs) | yes (fallback) | SRC/SRC/DOCS/CODE |
| `session/list`                    | C→A           | stable      | yes (ac-agent:550) | yes (L644) | undocumented | **no** | SRC/SRC/—/CODE |
| `session/fork`                    | C→A           | UNSTABLE    | yes (`unstable_forkSession` ac-agent:508) | **no** | undocumented | yes (`ACPAdapter.forkSession`) | SRC/SRC/—/CODE |
| `session/resume`                  | C→A           | UNSTABLE (stable in spec 2026-04-22) | yes (`unstable_resumeSession` ac-agent:527) | **no** | undocumented | yes if `caps.sessionCapabilities.resume` (acp-session:145) | SRC/SRC/—/CODE |
| `session/close`                   | C→A           | UNSTABLE (stable in spec 2026-04-23) | yes (`unstable_closeSession` ac-agent:1082) | yes (`close_session` L706) | undocumented | **no** | SRC/SRC/—/CODE |
| `session/prompt`                  | C→A           | stable      | yes (ac-agent:576) | yes (L725) | yes (docs) | yes | SRC/SRC/DOCS/CODE |
| `session/cancel` (notification)   | C→A           | stable      | yes (ac-agent:1050) | yes (L737) | yes (docs) | yes | SRC/SRC/DOCS/CODE |
| `session/set_mode`                | C→A           | stable      | yes (ac-agent:1106) | yes (L743) — approval-preset semantics | undocumented on ACP page | partial (via setSessionConfigOption for "mode") | SRC/SRC/—/CODE |
| `session/set_model`               | C→A           | UNSTABLE    | yes (`unstable_setSessionModel` ac-agent:1090) | yes (L754, format `"{preset}/{effort}"`) | undocumented | yes if `state.models` advertised (acp-session:190) | SRC/SRC/—/CODE |
| `session/set_config_option`       | C→A           | stable      | yes (ac-agent:1116, IDs: `mode`/`model`/`effort`) | yes (L767, IDs: `mode`/`model`/`reasoning_effort`) | undocumented | yes (acp-session:160) | SRC/SRC/—/CODE |
| `session/request_permission`      | A→C           | stable      | yes (5-option set for `ExitPlanMode`; 3-option set otherwise) | yes (4 distinct flows — see §13) | yes (3 outcome strings) | yes (acp.ts:359 clientImpl.requestPermission) | SRC/SRC/DOCS/CODE |
| `session/update` (notification)   | A→C           | stable      | yes | yes | yes (`agent_message_chunk` named) | yes | SRC/SRC/DOCS/CODE |
| `fs/read_text_file`               | A→C           | stable      | pass-through (ac-agent:1234) | not observed in thread.rs | capability-gated (`fs.readTextFile: false` in example) | we forward | SRC/—/DOCS/CODE |
| `fs/write_text_file`              | A→C           | stable      | pass-through (ac-agent:1239) | not observed in thread.rs | capability-gated | we forward | SRC/—/DOCS/CODE |
| `terminal/create`                 | A→C           | stable      | **not called** — Claude uses `_meta.terminal_info` instead | not called (Codex uses `Terminal` content-block + `meta.terminal_output` flag) | capability-gated (`terminal: false` in example) | not yet observed in our adapter | SRC/SRC/DOCS/CODE |
| `terminal/output`                 | A→C           | stable      | not called | not called | capability-gated | not called | SRC/SRC/DOCS/CODE |
| `terminal/release`                | A→C           | stable      | not called | not called | capability-gated | not called | SRC/SRC/DOCS/CODE |
| `terminal/wait_for_exit`          | A→C           | stable      | not called | not called | capability-gated | not called | SRC/SRC/DOCS/CODE |
| `terminal/kill`                   | A→C           | stable      | not called | not called | capability-gated | not called | SRC/SRC/DOCS/CODE |
| `logout`                          | C→A           | extension   | **no** | yes (`logout` L510) | pre-auth only (no ACP method documented) | **no** | SRC/SRC/DOCS/CODE |
| `$/cancel_request` (notification) | both          | UNSTABLE    | not observed | not observed | undocumented | not observed | SPEC |
| `extMethod` / `extNotification`   | both          | escape hatch | Claude uses `extNotification("_claude/sdkMessage", ...)` when `emitRawSDKMessages` is enabled | not observed | not documented | not observed | SRC/—/—/CODE |

**Gaps worth calling out:**

1. `session/list` — Claude and Codex both expose it. We don't call it. We maintain our own `session_map` SQLite table instead.
2. `session/close` — Claude, Codex both have it (Claude via `unstable_closeSession`). We tear down the whole process. Blocker for connection-per-agent refactor.
3. `logout` — Codex-only. We don't call it; stale credentials require process kill.
4. Neither we nor any of the three agents implement `terminal/*` yet — they all pass terminal data through `_meta` extensions on `tool_call` updates. This is effectively a frozen part of the spec.

---

## 4. SessionUpdate variant coverage matrix

Every variant in `#/$defs/SessionUpdate` from SDK 0.16.1, cross-referenced.

| Variant                    | SDK status | Claude emits | Codex emits | Cursor emits | Our translator handles | Our output                     | Conf |
| -------------------------- | ---------- | ------------ | ----------- | ------------ | ---------------------- | ------------------------------ | ---- |
| `user_message_chunk`       | stable     | yes (role=user, ac-agent:2234) | only in replay (thread.rs:3387) | undocumented | yes (translate-session-update.ts:307) **→ `[]`** | dropped | SPEC/SRC/SRC/DOCS/CODE |
| `agent_message_chunk`      | stable     | yes (text/image/text_delta/compaction) | yes (L1042 delta, L1081 non-delta dedup via `seen_message_deltas`) | yes (only variant docs name) | yes (:254) | `text-delta` / `image-delta` / warn-drop | SPEC/SRC/SRC/DOCS/CODE |
| `agent_thought_chunk`      | stable     | yes (thinking/thinking_delta) | yes (L1053 delta, L1086 non-delta dedup) | undocumented | yes (:255) | `thinking-delta` only for text + resource.text; audio/resource_link dropped | SPEC/SRC/SRC/DOCS/CODE |
| `tool_call`                | stable     | yes (ac-agent:2334) | synthesized from EventMsg (L1106 web search begin, L1134 exec begin, L1158 dynamic, L1169 MCP, L1202 patch begin, L1285 view image, L1350 guardian) | undocumented | yes (:311) | `tool-start` + drains | SPEC/SRC/SRC/DOCS/CODE |
| `tool_call_update`         | stable     | yes (ac-agent:2320 status transition, 2398 on result, 2382 for terminal, 2285 from Edit hook) | synthesized from EventMsg (L1111 web search end, L1141 exec output/end, L1162 dynamic response, L1179 MCP end, L1209 patch end) | undocumented | yes (:356) | `tool-input`/`tool-output`/`tool-error` + drains | SPEC/SRC/SRC/DOCS/CODE |
| `plan`                     | stable     | yes (ac-agent:2268 when `TodoWrite` with `input.todos[]`) | yes (L2508 from `PlanUpdate` event, hard-coded `priority=Medium`, `explanation` dropped) | undocumented | yes (:432) | `todo-update` | SPEC/SRC/SRC/DOCS/CODE |
| `available_commands_update`| stable     | yes (ac-agent:1392, filters out `cost`/`keybindings-help`/`login`/`logout`/`output-style:new`/`release-notes`/`todos`) | yes (thread.rs:2635 async after session load; built-ins: `review`/`review-branch`/`review-commit`/`init`/`compact`/`undo`/`logout`) | undocumented | yes (:442) **→ `[]`** | **dropped silently** | SPEC/SRC/SRC/DOCS/CODE |
| `current_mode_update`      | stable     | yes (ac-agent:1298 ExitPlanMode allow, 1163 setSessionConfigOption `mode`, 1639 PostToolUse `onEnterPlanMode`) | yes (indirect via ExitedReviewMode, L1300) | undocumented | yes (:446) | `session-agent` | SPEC/SRC/SRC/DOCS/CODE |
| `config_option_update`     | stable     | yes (ac-agent:1411 `updateConfigOption`) | yes (L2950 `maybe_emit_config_options_update` dedups) | undocumented | yes (:450) | `config-update` | SPEC/SRC/SRC/DOCS/CODE |
| `session_info_update`      | stable     | not observed in survey (Claude has `sanitizeTitle` at `listSessions` but not this variant) | yes (L1093 from `ThreadNameUpdated`, title only) | undocumented | yes (:454) | `session-title` only if `title` set; else `[]` | SPEC/SRC/SRC/DOCS/CODE |
| `usage_update`             | **UNSTABLE** | yes (ac-agent:675 compact_boundary; 749 result; 869 message_start/delta; with `cost` only on `result`) | yes (thread.rs:1021 from `TokenCount`, silently dropped if `info` or `model_context_window` is None) | undocumented | yes (:461) | `usage` (size/used/cost) | SPEC/SRC/SRC/DOCS/CODE |

### SessionUpdate variants Claude emits that are not in our translator
None. All 10 Claude-emittable variants have matching cases.

### SessionUpdate variants Codex can emit that are not in our translator
None. All 10 Codex-emittable variants have matching cases.

### Non-SessionUpdate Claude notifications
- `extNotification("_claude/sdkMessage", {sessionId, message})` — out-of-spec raw-SDK-message debug channel gated by `emitRawSDKMessages` (ac-agent:638).
  **Our handling:** not observed; the SDK's `ClientSideConnection` would ignore unknown extension notifications.

---

## 5. ToolCallContent + ContentBlock coverage

Per SDK 0.16.1 `#/$defs/ToolCallContent` (discriminator `type`):

### ToolCallContent variants

| type      | SDK | Claude emits | Codex emits | Cursor docs | Our handling (drainContent, acp-state.ts:537) | Conf |
| --------- | --- | ------------ | ----------- | ----------- | ---------------------------------------------- | ---- |
| `content` | stable | yes (wrapped `ContentBlock`) | yes (for reason text, MCP elicitation body, guardian, fenced-code exec output) | not documented | stored in state but only diff/terminal emitted; **other content items stored in state but not emitted as events** (acp-state.ts:553) | SPEC/SRC/SRC/DOCS/CODE |
| `diff`    | stable | yes (Edit/Write tools) | yes (PatchApplyBegin/End, ApplyPatchApprovalRequest) | undocumented in Cursor docs but registry rule 4 expects it | yes — `drainContent` emits `file-diff` AgentEvent keyed by `diffKey = "${path}:${oldText ?? ""}:${newText}"` | SPEC/SRC/SRC/DOCS/CODE |
| `terminal`| stable | yes — gated on client `_meta["terminal-auth"]` / `supportsTerminalOutput` | yes — gated on `client_capabilities.meta.terminal_output` | undocumented | yes — `drainContent` emits `tool-terminal` | SPEC/SRC/SRC/DOCS/CODE |

### ContentBlock variants (inside `content.content`)

| type            | SDK | Claude emits | Codex emits | Cursor docs | Our handling | Conf |
| --------------- | --- | ------------ | ----------- | ----------- | ------------ | ---- |
| `text`          | stable | yes | yes | `{type:"text"}` shown in prompt example | `text-delta` / `thinking-delta` | SPEC/SRC/SRC/DOCS/CODE |
| `image`         | stable | yes (tool results, `base64` → `{data,mimeType}`) | yes (`ViewImageToolCall` → ResourceLink; `DynamicToolCallResponse.InputImage` → ResourceLink) | undocumented in user prompts | `image-delta` in message chunk; **dropped in thought chunk** (translate-session-update.ts:275–279 policy) | SPEC/SRC/SRC/DOCS/CODE |
| `audio`         | stable | not observed | not observed (explicitly dropped from prompt input at thread.rs:3711) | undocumented | `audio-delta` in message; **dropped in thought** (policy) | SPEC/SRC/SRC/DOCS/CODE |
| `resource_link` | stable | yes (via `formatUriAsLink` with `file://`/`zed://`) | yes (via ViewImageToolCall → ResourceLink) | undocumented | `resource-link-delta` in message; **dropped in thought** (policy) | SPEC/SRC/SRC/DOCS/CODE |
| `resource` (TextResourceContents) | stable | yes (with appended `<context ref="...">...</context>` at end) | yes (but **non-text resources silently dropped**, thread.rs:3711) | undocumented | unwrapped to text-delta / thinking-delta | SPEC/SRC/SRC/DOCS/CODE |
| `resource` (BlobResourceContents) | stable | observed rarely | explicitly dropped in prompt input | undocumented | **silently dropped** — translate-session-update.ts:291-299 | SPEC/SRC/SRC/DOCS/CODE |

### Cross-agent content taxonomy — where we lose information

- **`text_editor_code_execution_str_replace_result` (Claude)** — Claude emits a `lines[]` array for str-replace patches that our translator never sees as `diff`; it arrives via the `tool_call_update` result content pathway and we stringify via the generic content-block path. Useful info (per-hunk diff) flattened to text.
- **Multiple ContentBlock variants inside one `tool_call_update.content`** (Codex) — our `drainContent` only emits `file-diff` and `tool-terminal`; every other content item is stored in `ToolState.content` but never fires an AgentEvent. Items silently accumulate with no UI output.
- **`DynamicToolCallResponse.InputImage` (Codex)** — maps to ResourceLink with the `image_url` used for **both** `name` and `uri`. Not a bug on our side but a pre-existing Codex-side flattening.

---

## 6. Enums

### ToolKind (`#/$defs/ToolKind`, SDK 0.16.1)

| Value         | SDK description                     | Who emits                                                  | Our intent derivation (acp-state.ts:297) |
| ------------- | ----------------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| `read`        | Reading files/data                  | Claude (Read, ac-agent); Codex (ViewImageToolCall, exec if parsed as read) | → intent `read` |
| `edit`        | Modifying files/content             | Claude (Write/Edit); Codex (Patch*) | → intent `edit` |
| `delete`      | Removing files/data                 | Codex (exec kind=delete via parsed_cmd) | → intent `delete` |
| `move`        | Moving/renaming files               | Codex (exec kind=move via parsed_cmd) | → intent `move` |
| `search`      | Searching                           | Claude (Grep/Glob/WebSearch); Codex (exec kind=search) | → intent `search` (or `list` if `mode==="files"`) |
| `execute`     | Running commands or code            | Claude (Bash); Codex (exec) | → intent `shell` |
| `think`       | Internal reasoning                  | Claude (Agent/Task/TodoWrite); Codex (GuardianAssessment) | → intent `reasoning` |
| `fetch`       | Retrieving external data            | Claude (WebFetch, WebSearch); Codex (fetch) | → intent `fetch` |
| `switch_mode` | Switching session mode              | Claude (ExitPlanMode) | → intent `reasoning` (via registry rule 41) |
| `other`       | Default fallback                    | Claude (Other + unknown); Codex (DynamicToolCall, MCP — **none of these set `kind`**) | → intent `generic` |

### ToolCallStatus

| Value         | Meaning                                    |
| ------------- | ------------------------------------------ |
| `pending`     | Not started (streaming input / awaiting approval) |
| `in_progress` | Currently running                          |
| `completed`   | Completed successfully                     |
| `failed`      | Failed with error                          |

**Our normalization** (translate-session-update.ts:358–363): `completed`/`failed` pass through; `in_progress` → `running` internally; anything else → `pending`.

### StopReason (SDK)

| Value               | Meaning                                    | Emitted by                                        | Our handling (translate-session-update.ts:481) |
| ------------------- | ------------------------------------------ | ------------------------------------------------- | --------------------------------------------- |
| `end_turn`          | Turn ended successfully                    | Claude (success + not max_tokens); Codex (TurnComplete) | `[session-status(idle), finish]` |
| `max_tokens`        | Reached max tokens                         | Claude | `[session-status(idle), finish]` |
| `max_turn_requests` | Reached max requests between user turns    | Claude (error_max_budget_usd / error_max_turns / error_max_structured_output_retries) | `[session-status(idle), finish]` |
| `refusal`           | Agent refused                              | Claude | `[session-status(error), error("Request refused by agent")]` |
| `cancelled`         | Client cancelled                           | Claude; Codex (TurnAborted, ShutdownComplete) | `[session-status(idle)]` (no `finish`) |

### PermissionOptionKind

| Value          | SDK description                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `allow_once`   | Allow only this time                                                                              |
| `allow_always` | Allow and remember                                                                                |
| `reject_once`  | Reject only this time                                                                             |
| `reject_always`| Reject and remember                                                                               |

**Per-agent usage** — see §13.

---

## 7. Capabilities negotiation

### AgentCapabilities (agent → client, in `initialize` response)

| Field                               | SDK status | Claude advertises               | Codex advertises                | Cursor advertises | Our adapter reads | Conf |
| ----------------------------------- | ---------- | ------------------------------- | ------------------------------- | ----------------- | ----------------- | ---- |
| `loadSession`                       | stable     | **`true`** (ac-agent:468)      | **`true`** (L423)              | undocumented       | yes (acp-session:149) | SRC/SRC/DOCS/CODE |
| `sessionCapabilities.fork`          | UNSTABLE   | `{}` (advertise yes)            | not advertised                  | undocumented       | read via `resume()` branch only | SRC/SRC/DOCS/CODE |
| `sessionCapabilities.list`          | stable     | `{}`                            | `{}` (L423)                    | undocumented       | **not read**       | SRC/SRC/DOCS/CODE |
| `sessionCapabilities.resume`        | UNSTABLE   | `{}`                            | not advertised                  | undocumented       | yes (acp-session:145) | SRC/SRC/DOCS/CODE |
| `sessionCapabilities.close`         | UNSTABLE   | `{}`                            | `{}` (L422)                    | undocumented       | **not read**       | SRC/SRC/DOCS/CODE |
| `promptCapabilities.image`          | stable     | `true`                          | `true` (prompt.image)          | undocumented       | yes (acp-session:234) gates outgoing | SRC/SRC/DOCS/CODE |
| `promptCapabilities.audio`          | stable     | not set (implicit false)        | not set (implicit false)       | undocumented       | yes gates outgoing | SRC/SRC/DOCS/CODE |
| `promptCapabilities.embeddedContext`| stable     | `true`                          | `true` (prompt.embedded_context) | undocumented     | yes (acp-session:258) | SRC/SRC/DOCS/CODE |
| `mcpCapabilities.http`              | stable     | `true`                          | `true`                         | undocumented       | **not read explicitly** | SRC/SRC/DOCS/CODE |
| `mcpCapabilities.sse`               | stable     | `true`                          | `false` — Codex SSE silently dropped (codex_agent.rs:321) | undocumented | **not read** | SRC/SRC/DOCS/CODE |
| `_meta.claudeCode.promptQueueing`   | extension  | `true`                          | —                              | —                  | **not read**       | SRC |
| `auth.*` (UNSTABLE)                 | UNSTABLE   | `AuthCapabilities` built from `AuthMethod` list including gateway/terminal/env_var variants | `AuthAgentCapabilities` with logout | undocumented | **not read**  | SRC/SRC/DOCS/CODE |
| `auth._meta.gateway` (extension)    | extension  | gated by `clientCapabilities.auth._meta.gateway===true` | — | — | **not read** | SRC |

### ClientCapabilities (client → agent, in `initialize` request)

| Field                       | SDK status | Our adapter advertises (acp.ts:420) | Conf |
| --------------------------- | ---------- | ----------------------------------- | ---- |
| `fs.readTextFile`           | stable     | `true`                              | CODE |
| `fs.writeTextFile`          | stable     | `true`                              | CODE |
| `terminal`                  | stable     | `true`                              | CODE |
| `auth.terminal`             | UNSTABLE   | `false`                             | CODE |
| `auth._meta.gateway`        | extension  | not advertised                      | CODE |
| `_meta.terminal-auth`       | extension (Claude-used) | not advertised                | CODE |
| `meta.terminal_output`      | extension (Codex-used) | **not advertised** → Codex falls back to fenced-code rendering | CODE |

**Gap:** We don't advertise `meta.terminal_output` (Codex extension). As a
result, Codex renders shell output as fenced markdown (```sh) instead of
piping it through an embedded `terminal/*` surface. Our registry rule 18
(`codex-shell` → `terminal_output.stdout/stderr` evidence) is accommodating
this but a richer terminal experience is blocked on us flipping the flag.

---

## 8. Claude — exhaustive vocabulary

### 8.1 Tools — complete inventory from `claude-agent-acp/src/tools.ts`

Every case in `toolInfoFromToolUse` (tools.ts:121–411) AND `toolUpdateFromToolResult` (tools.ts:413–552).

| Tool name       | `rawInput` fields                                                                                                    | ACP `kind`     | Title                                       | Content emitted                                                                 | Result shape                                                                                | Our intent | Our rule # |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------- | ---------- |
| `Agent`         | `AgentInput` — `description?`, `prompt?`                                                                             | `think`        | `input.description ?? "Task"`               | `[{type:"content", content:{text: input.prompt}}]` if prompt                    | (handled at model level; no special case in `toolUpdateFromToolResult`)                    | `task`     | 42 (claude-task) |
| `Task`          | same as `Agent` (tools.ts:131 types as `AgentInput \| BashInput` — the `BashInput` is a TS typo)                     | `think`        | same                                        | same                                                                            | same                                                                                        | `task`     | 42 |
| `Bash`          | `BashInput` — `command`, `description?`                                                                              | `execute`      | `input.command ?? "Terminal"`               | `[{type:"terminal", terminalId: toolUse.id}]` if `supportsTerminalOutput`; else text of description; else `[]` | `BetaBashCodeExecutionResultBlock` → `_meta.terminal_{info,output,exit}` with exit_code from `return_code` or `is_error?1:0` if terminal supported; else fenced `` ```console `` block | `shell`    | 32 (claude-shell) |
| `Read`          | `FileReadInput` — `file_path`, `offset?`, `limit?`                                                                   | `read`         | `"Read " + displayPath + " lines " + range`  | `[]`                                                                            | `content: string \| Array<{type:"text", text}>` — each text block wrapped via `markdownEscape` | `read`    | 33 (claude-read) |
| `Write`         | `FileWriteInput` — `file_path`, `content`                                                                            | `edit`         | `"Write " + displayPath`                    | `[{type:"diff", path, oldText: null, newText: content}]` if file_path           | **handled via PostToolUse hook** (tools.ts:536–539 returns `{}`)                           | `edit`     | 34 (claude-write) |
| `Edit`          | `FileEditInput` — `file_path`, `old_string`, `new_string`, `replace_all?`                                            | `edit`         | `"Edit " + displayPath`                     | `[{type:"diff", path, oldText: old_string\|null, newText: new_string ?? ""}]` when either string present | **handled via PostToolUse hook** — `toolUpdateFromEditToolResponse` parses `structuredPatch[]` | `edit` | 35 (claude-edit) |
| `Glob`          | `GlobInput` — `path?`, `pattern?`                                                                                    | `search`       | `"Find" + backtick-wrapped path + pattern`  | `[]`                                                                            | default text mapping                                                                        | `list`     | 36 (claude-glob) |
| `Grep`          | `GrepInput` — `pattern`, `-i`, `-n`, `-A`, `-B`, `-C`, `output_mode?` (`files_with_matches`/`count`/`content`), `head_limit?`, `glob?`, `type?`, `multiline?`, `path?` | `search` | built-up grep command string | `[]`                                                                            | default text mapping                                                                        | `search`   | 37 (claude-grep) |
| `WebFetch`      | `WebFetchInput` — `url`, `prompt?`                                                                                   | `fetch`        | `"Fetch " + url`                            | text of prompt if present                                                       | default text mapping                                                                        | `fetch`    | 38 (claude-webfetch) |
| `WebSearch`     | `WebSearchInput` — `query`, `allowed_domains[]?`, `blocked_domains[]?`                                               | `fetch`        | `"\"query\"" + suffixes`                    | `[]`                                                                            | default text mapping                                                                        | `search`   | 39 (claude-websearch) |
| `TodoWrite`     | `TodoWriteInput` — `todos: [{content, status, activeForm}]`                                                          | `think`        | `"Update TODOs: " + joined todo.content`    | `[]` **but see special-case: emitted as `sessionUpdate: "plan"` notification instead of tool_call when input.todos is an array** | not emitted as tool_call; bypasses pipeline                                                  | `todos`    | 40 (claude-todos) |
| `ExitPlanMode`  | `{plan?: string}`                                                                                                    | `switch_mode`  | `"Ready to code?"`                          | text of plan if present                                                         | `{title: "Exited Plan Mode"}` (tools.ts:541)                                                | `reasoning`| 41 (claude-plan) |
| `Other` (literal name) | any                                                                                                           | `other`        | `name ?? "Unknown Tool"`                    | `[{type:"content", content:{text:"```json\n"+JSON.stringify(input,null,2)+"```"}}]`, fallback to string/empty | default text mapping via `toAcpContentUpdate` | `generic`  | 43 (claude-generic) |
| `ToolSearch`, `Skill`, `LSP`, `CronCreate`, `CronList`, `CronDelete`, MCP tools | variable | `other`        | `name ?? "Unknown Tool"`                    | `[]`                                                                            | default text mapping                                                                        | `generic`  | 43/44 (claude-generic) |

**Hardcoded disallowed tool:** `AskUserQuestion` — ac-agent:1592, merged into SDK's `disallowedTools`, with a comment `// in progress work so we can revisit`. **This means Claude via ACP cannot invoke `AskUserQuestion` today.**

**Beta content variants Claude produces as result content blocks** (tools.ts:590–656, `toAcpContentBlock`):

| block `type`                                      | Fields read                               | Mapped to                                                              |
| ------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `text`                                            | `content.text`                            | `{type:"text", text}` (fenced if error)                                |
| `image`                                           | `source.type` = `base64`/`url`/`file`     | `{type:"image", data, mimeType}` for base64; text placeholder otherwise |
| `tool_reference`                                  | `content.tool_name`                       | text `"Tool: <name>"`                                                  |
| `tool_search_tool_search_result`                  | `tool_references[].tool_name`             | text `"Tools found: a, b, c"` or `"none"`                              |
| `tool_search_tool_result_error`                   | `error_code`, `error_message`             | text `"Error: <code> - <msg>"`                                         |
| `web_search_result`                               | `title`, `url`                            | text `"<title> (<url>)"`                                               |
| `web_search_tool_result_error`                    | `error_code`                              | text `"Error: <code>"`                                                 |
| `web_fetch_result`                                | `url`                                     | text `"Fetched: <url>"`                                                |
| `web_fetch_tool_result_error`                     | `error_code`                              | text `"Error: <code>"`                                                 |
| `code_execution_result`                           | `stdout`, `stderr`                        | text `"Output: ..."`                                                   |
| `bash_code_execution_result`                      | `stdout`, `stderr`                        | text `"Output: ..."` (default case only; Bash pathway uses terminal)   |
| `code_execution_tool_result_error`                | `error_code`                              | text `"Error: <code>"`                                                 |
| `bash_code_execution_tool_result_error`           | `error_code`                              | text `"Error: <code>"`                                                 |
| `text_editor_code_execution_view_result`          | `content`                                 | wrapped text                                                           |
| `text_editor_code_execution_create_result`        | `is_file_update`                          | text `"File updated"` / `"File created"`                               |
| `text_editor_code_execution_str_replace_result`   | `lines[]`                                 | text from joined lines — **note: not mapped to `diff` content type**   |
| `text_editor_code_execution_tool_result_error`    | `error_code`, `error_message`             | text                                                                   |
| default                                           | —                                         | text = `JSON.stringify(content)`                                       |

### 8.2 Claude ACP methods (server-side)

| Method                        | Request                                                 | Response                                                    | Our mapping                            |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| `initialize`                  | `InitializeRequest` (w/ clientCapabilities.auth.terminal / _meta.terminal-auth / auth._meta.gateway) | `InitializeResponse` w/ agentCapabilities + authMethods | yes (we use `loadSession`, `sessionCapabilities.resume`) |
| `newSession`                  | `NewSessionRequest` + `_meta.claudeCode.options.resume` | `NewSessionResponse { sessionId, models, modes, configOptions }` | yes |
| `unstable_forkSession`        | `ForkSessionRequest`                                    | `ForkSessionResponse`                                       | yes (via `ACPAdapter.forkSession`)     |
| `unstable_resumeSession`      | `ResumeSessionRequest`                                  | `ResumeSessionResponse`                                     | yes (gated on `caps.sessionCapabilities.resume`) |
| `loadSession`                 | `LoadSessionRequest`                                    | `LoadSessionResponse` → replays via `getSessionMessages`, then `available_commands_update` | yes (fallback) |
| `listSessions`                | `ListSessionsRequest { cwd }`                           | `ListSessionsResponse { sessions: {sessionId, cwd, title (max 256), updatedAt} }` | **no** |
| `authenticate`                | `{methodId, _meta}`                                     | `void` — only `methodId === "gateway"` handled; others throw `"Method not implemented."` | partial (env-var auth pre-spawn) |
| `prompt`                      | `PromptRequest`                                         | `PromptResponse { stopReason, usage? }`                     | yes |
| `cancel` (notification)       | `CancelNotification`                                    | —                                                           | yes |
| `unstable_closeSession`       | `CloseSessionRequest`                                   | `CloseSessionResponse {}`                                   | **no**                                 |
| `unstable_setSessionModel`    | `SetSessionModelRequest`                                | `SetSessionModelResponse \| void`                           | yes                                    |
| `setSessionMode`              | `SetSessionModeRequest`                                 | `SetSessionModeResponse {}`                                 | yes                                    |
| `setSessionConfigOption`      | `SetSessionConfigOptionRequest`                         | `SetSessionConfigOptionResponse { configOptions }`          | yes                                    |

### 8.3 Claude subagent (`Task` / `Agent`) flow

- Parent tool has id `T`. Inner agent messages arrive with `message.parent_tool_use_id === T`.
- `streamEventToAcpNotifications` passes it into `toAcpNotifications` as `options.parentToolUseId` (ac-agent:2470-2487).
- Every inner `agent_message_chunk` / `tool_call` / `tool_call_update` gets `_meta.claudeCode.parentToolUseId: T` (ac-agent:2213-2222, 2431-2440).
- **Inner messages stream as independent session notifications, NOT embedded into parent tool content.** Client must reconstruct the parent/child relationship from `_meta.claudeCode.parentToolUseId`.
- Usage tracking explicitly excludes subagents: `if (message.type === "assistant" && message.parent_tool_use_id === null)` (ac-agent:925-931).

**Our handling:** we don't read `_meta.claudeCode.parentToolUseId`. All inner events render as independent tool calls with no nesting relationship in the UI.

### 8.4 Claude session config options

Built in `buildConfigOptions` (ac-agent:1870-1944):

| Config id | Category     | Type     | Values                                                                                                                     |
| --------- | ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `mode`    | `Mode`       | select   | `auto`, `default`, `acceptEdits`, `plan`, `dontAsk`, optionally `bypassPermissions` (gated by `ALLOW_BYPASS`)              |
| `model`   | `Model`      | select   | `ModelInfo[]` from SDK; `ANTHROPIC_MODEL` env highest priority for default                                                 |
| `effort`  | `ThoughtLevel` | select | `preset.supported_reasoning_efforts` — emitted only if `currentModelInfo.supportsEffort && efforts.length>0`               |

### 8.5 Claude-specific `_meta` extensions (non-spec)

All under `_meta.*`:
- `_meta.claudeCode.promptQueueing: true` — agentCapability
- `_meta.claudeCode.parentToolUseId` on every update when parent present
- `_meta.claudeCode.toolName` on tool_call updates
- `_meta.claudeCode.toolResponse` on Edit hook-driven tool_call_update
- `_meta["terminal-auth"]` — client capability for terminal-based auth
- `_meta.terminal_info`, `_meta.terminal_output`, `_meta.terminal_exit` on tool_call updates — comment says "matching codex-acp's _meta protocol" (ac-agent:241)
- `auth._meta.gateway.protocol: "anthropic"` — agent auth method extension
- `_claude/sdkMessage` — ext notification name for raw SDK message mirroring

### 8.6 Claude quirks

- **`AskUserQuestion` hardcoded disallowed** (ac-agent:1592, comment: `in progress work`).
- **Prompt queueing via `pendingMessages`** — concurrent `prompt()` calls queued, resolved on UUID replay (ac-agent:901–914).
- **Compact boundary emits `used:0`** deliberately-wrong usage until next real snapshot (ac-agent:661–691).
- **Context window inference** recognizes `\b1m\b` token → 1,000,000, else defaults 200,000 until `modelUsage` provides truth.
- **Slash command filter** suppresses `todos`, `login`, `logout`, `cost`, `keybindings-help`, `output-style:new`, `release-notes`.
- **Local-only commands** (`/context`, `/heapdump`, `/extra-usage`) forward `result.result` as `agent_message_chunk`.
- **Process death detection** error-message regex triggers session delete + `RequestError.internalError`.
- **TodoWrite bypasses `tool_call` path** — always emits `plan` SessionUpdate. If `input.todos` isn't an array, nothing is emitted.
- **ExitPlanMode permission has 5 options** (see §13.1) — the richest permission surface of the three agents.
- **Hooks as the ground truth for Edit/Write results** — tool_call_update from SDK's `tool_result` is bypassed for these tools; instead `PostToolUse` hook fires with `structuredPatch[]` and our adapter sees a synthesized tool_call_update containing `_meta.claudeCode.toolResponse`.

---

## 9. Codex — exhaustive vocabulary

Codex does not have a fixed *tool* vocabulary. It has an `EventMsg` enum
(40+ variants) that the adapter at `thread.rs:handle_event` translates into
synthesized ACP events. Tool identity is derived from event kind + parsed
command, not from a tool-name registry.

### 9.1 EventMsg → ACP translation table (complete)

Organized into emit-as-tool-call, emit-as-message-chunk, emit-as-permission,
and dropped. All from `thread.rs`.

#### 9.1a Tool-call synthesis

| EventMsg                          | Synthesized as                            | ACP shape                                                                                        | ToolKind | rawInput / content                                                    | thread.rs line |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------- | -------------- |
| `WebSearchBegin { call_id }`      | `tool_call`                               | `ToolCall::new(call_id, "Searching the Web")` no status set                                      | `Fetch`  | —                                                                      | 1106           |
| `WebSearchEnd { call_id, query, action }` | `tool_call_update`                | `status=InProgress`, title built from `action`                                                   | (unchg)  | `{query, action}`                                                     | 1111           |
| `ExecApprovalRequest { call_id, turn_id, cwd, reason, parsed_cmd, available_decisions, network_approval_context, additional_permissions, proposed_execpolicy_amendment, approval_id }` | `session/request_permission` | `ToolCallUpdate { kind, status=Pending, title, rawInput=entire event, content=joined text, locations }` | from `parse_command_tool_call` | whole event JSON | 1123 |
| `ExecCommandBegin { call_id, cwd, parsed_cmd }` | `tool_call`                | `status=InProgress`, locations, content=`[Terminal(call_id)]` if `meta.terminal_output=true` else `[]`, `_meta.terminal_info` when terminal supported | from `parse_command_tool_call` | whole event | 1134 |
| `ExecCommandOutputDelta { call_id, chunk, stream }` | `tool_call_update`         | if terminal: `_meta.terminal_output = {terminal_id, data}`; else: fenced code block (lang from file_extension or `sh`, `md` raw) | (unchg) | — | 1141 |
| `ExecCommandEnd { call_id, exit_code, status (ExecCommandStatus) }` | `tool_call_update` | `status=Completed`/`Failed`, `rawOutput=event JSON`, `_meta.terminal_exit={terminal_id, exit_code, signal:null}` when terminal supported | (unchg) | event | 1144 |
| `TerminalInteraction { call_id, process_id, stdin }` | `tool_call_update`       | same as output delta but with `\n{stdin}\n`                                                      | (unchg)  | —                                                                     | 1151           |
| `ApplyPatchApprovalRequest { call_id, changes, reason, grant_root (**ignored**), turn_id }` | `session/request_permission` | `ToolCallUpdate { kind=Edit, status=Pending, title, locations, content=diffs + reason, rawInput=event }` | `Edit`   | event                                                                  | 1191           |
| `PatchApplyBegin { call_id, auto_approved (ignored), changes, turn_id }` | `tool_call`         | `kind=Edit, status=InProgress, title from changes, locations, content=diffs, rawInput=event`    | `Edit`   | event                                                                  | 1202           |
| `PatchApplyEnd { call_id, stdout (ignored), stderr (ignored), success, changes, status (PatchApplyStatus) }` | `tool_call_update` | `status` from `PatchApplyStatus` (Completed/Failed/success fallback), `rawOutput=event`, updated title+locations+content if `changes` non-empty | (unchg) | event | 1209 |
| `DynamicToolCallRequest { call_id, turn_id, tool, arguments }` | `tool_call`              | `ToolCall::new(call_id, "Tool: {tool}").status(InProgress).raw_input(arguments)` — **no `kind` set**   | (none)   | arguments                                                              | 1158           |
| `DynamicToolCallResponse { call_id, turn_id, tool, arguments, content_items, success, error, duration (ignored) }` | `tool_call_update` | `status=Completed`/`Failed`, `rawOutput=event`, `content` from items (`InputText`→Content, `InputImage`→ResourceLink w/ `image_url` as both name and uri) + error appended as Content | (unchg) | — | 1162 |
| `McpToolCallBegin { call_id, invocation{server, tool, ...} }` | `tool_call`                | `"Tool: {server}/{tool}"`, status=InProgress, raw_input=invocation — **no `kind` set**          | (none)   | invocation                                                             | 1169           |
| `McpToolCallEnd { call_id, invocation, duration (ignored), result }` | `tool_call_update`      | `status=Completed/Failed` (from `result.is_error` or `Err`), `rawOutput=result JSON`, content = `result.content[]` filter_mapped via `serde_json::from_value::<ContentBlock>` — **invalid blocks silently dropped** | (unchg) | — | 1179 |
| `ViewImageToolCall { call_id, path }` | `tool_call`                           | `"View Image {path}"`, kind=Read, status=Completed, content=`[ResourceLink(display_path, display_path)]`, locations=`[{path}]` | `Read`   | —                                                                     | 1285           |
| `RequestPermissions { call_id, turn_id, reason, permissions (PermissionProfile) }` | `session/request_permission` | `ToolCallUpdate { status=Pending, title=reason or "Permissions Request", rawInput=event, content=joined lines: reason + FS read/write paths + network }` | (none)   | event                                                                 | 1342           |
| `ElicitationRequest { server_name, id, request, turn_id }` (Form with `meta.codex_approval_kind == "mcp_tool_call"`) | `session/request_permission` | ToolCallUpdate w/ text body from `meta.tool_title`, `connector_name`, etc. | (none) | event | 1326 |
| `GuardianAssessment { id, status, action, risk_level, risk_score, rationale, turn_id }` | `tool_call` or update (depending on active_guardian_assessments membership) | `toolCallId=guardian_assessment:{id}`, title=`"Guardian Review"`, kind=Think, status-mapping, content=text lines | `Think` | event | 1350 |

#### 9.1b Message-chunk synthesis

| EventMsg                                                              | Synthesized as                  | Notes                                                                    | thread.rs line |
| --------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ | -------------- |
| `AgentMessageContentDelta { delta }`                                  | `agent_message_chunk` (delta)   | sets `seen_message_deltas=true` to dedupe                                | 1042           |
| `AgentMessage { message, phase (ignored), memory_citation (ignored) }`| `agent_message_chunk` (non-delta) | only if no deltas seen in this turn; consumes `seen_message_deltas`    | 1079           |
| `ReasoningContentDelta { delta }` / `ReasoningRawContentDelta { delta }` | `agent_thought_chunk`         | sets `seen_reasoning_deltas=true`                                        | 1052           |
| `AgentReasoningSectionBreak { summary_index }`                        | `agent_thought_chunk` with `"\n\n"` | —                                                                    | 1070           |
| `AgentReasoning { text }`                                             | `agent_thought_chunk` (non-delta) | only if no deltas seen                                                 | 1086           |
| `UndoStarted { message? }`                                            | `agent_message_chunk`           | text = `event.message` or `"Undo in progress..."`                        | 1233           |
| `UndoCompleted { message?, success }`                                 | `agent_message_chunk`           | text from message or `"Undo completed."`/`"Undo failed."`                | 1240           |
| `ExitedReviewMode { review_output? }`                                 | `agent_message_chunk`           | text via `format_review_findings_block` fallback                         | 1300           |
| `Warning { message }`                                                 | `agent_message_chunk`           | warning text                                                             | 1308           |
| `ContextCompacted { ... (ignored) }`                                  | `agent_message_chunk`           | text = `"Context compacted\n"`                                           | 1338           |

#### 9.1c Other synthesis

| EventMsg                                  | Synthesized as                     | thread.rs line |
| ----------------------------------------- | ---------------------------------- | -------------- |
| `ThreadNameUpdated { thread_name }`       | `session_info_update { title }` if Some(name) | 1093 |
| `PlanUpdate { explanation (dropped), plan (Vec<PlanItemArg>) }` | native `plan` SessionUpdate with hard-coded `priority=Medium`, status mapped | 1101 |
| `TokenCount { info: {model_context_window, last_token_usage} }` | `usage_update {used, size}` — silent drop if info.model_context_window is None | 1021 |
| `TurnComplete { last_agent_message, turn_id }` | `StopReason::EndTurn` on prompt future | 1223 |
| `TurnAborted { reason, turn_id }`         | `StopReason::Cancelled`            | 1271           |
| `ShutdownComplete`                        | `StopReason::Cancelled`            | 1278           |
| `Error { message, codex_error_info }`     | prompt future resolves with `Err(Error::internal_error().data({...}))` — **session continues**, prompt fails | 1257 |

#### 9.1d **Silently dropped events** (logged only or in ignore wildcard — potential bugs)

| EventMsg                                   | thread.rs line | Notes                                                                                |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------ |
| `StreamError { message, codex_error_info, additional_details }` | 1248 | **NOT forwarded** — logged only. Potentially serious: mid-stream errors vanish. |
| `ModelReroute { from_model, to_model, reason }` | 1334      | **NOT forwarded** — client never sees model swap mid-turn.                          |
| `TurnStarted`                              | 1014           | log only                                                                             |
| `ItemStarted`, `ItemCompleted`             | 1031, 1216     | log only                                                                             |
| `UserMessage` (live path)                  | 1034           | log only; replay path does forward (3387-3389)                                       |
| `McpStartupUpdate`, `McpStartupComplete`   | 1314, 1317     | log only                                                                             |
| `EnteredReviewMode`                        | 1297           | log only                                                                             |
| `ImageGenerationBegin`/`End`               | 1359–1360      | wildcard drop                                                                        |
| `AgentReasoningRawContent`                 | 1361           | wildcard drop in live path; **but handled in replay** (inconsistency)                |
| `ThreadRolledBack`                         | 1362           | wildcard                                                                             |
| `HookStarted`/`HookCompleted`              | 1363–1364      | wildcard                                                                             |
| `TurnDiff`                                 | 1366           | wildcard; comment: "we already have a way to diff the turn"                          |
| `BackgroundEvent`                          | 1367           | wildcard; TODO "Revisit when we can emit status updates"                             |
| `SkillsUpdateAvailable`                    | 1369           | wildcard                                                                             |
| `AgentMessageDelta` / `AgentReasoningDelta` / `AgentReasoningRawContentDelta` | 1371 | wildcard; commented "Old events"                                          |
| `RawResponseItem`                          | 1374           | wildcard                                                                             |
| `SessionConfigured`                        | 1375           | wildcard                                                                             |
| `CollabAgentSpawnBegin/End`, `CollabAgentInteractionBegin/End` | 1376 | wildcard; TODO "Subagent UI?" — **codex does have subagent events, all currently dropped** |
| `RealtimeConversationStarted/Realtime/Closed` | 1382        | wildcard                                                                             |
| `CollabWaitingBegin/End`, `CollabResumeBegin/End`, `CollabCloseBegin/End` | 1385 | wildcard                                                                   |
| `PlanDelta`                                | 1390           | wildcard                                                                             |
| `McpListToolsResponse`, `ListCustomPromptsResponse`, `ListSkillsResponse`, `GetHistoryEntryResponse`, `DeprecationNotice`, `RequestUserInput` | 1391 | warn-on (`warn!("Unexpected event: ...")`) but not forwarded |

### 9.2 Codex ACP methods (non-spec extensions visible server-side)

| Method                 | Request                                                            | Response                                               | Our mapping                |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ | -------------------------- |
| `list_sessions`        | `ListSessionsRequest { cwd, cursor }`                              | paged 25 items, filters sources `[Cli, VSCode, Unknown]`, title via `format_session_title` (120 grapheme cap) | **no** |
| `logout`               | `LogoutRequest`                                                    | `LogoutResponse` — calls `auth_manager.logout()`       | **no** |
| `close_session`        | `CloseSessionRequest`                                              | `CloseSessionResponse` — submits `Op::Shutdown`, removes from `sessions` + `session_roots` | **no** |
| `authenticate`         | `AuthenticateRequest { method_id }`                                | short-circuits if already authed; `ChatGpt` opens browser; API-key methods call `login_with_api_key` | partial (env-var pre-auth) |
| `set_session_mode`     | `SetSessionModeRequest { mode_id }` — **approval-preset semantics**| `SetSessionModeResponse::default()`                    | partial                    |
| `set_session_model`    | `SetSessionModelRequest { model_id }` — format `"{preset}/{effort}"` | `SetSessionModelResponse::default()`                  | yes                        |
| `set_session_config_option` | `SetSessionConfigOptionRequest { session_id, config_id, value }` — IDs: `mode`, `model`, `reasoning_effort` | returns **refreshed options vector** (non-default behavior) | yes |

### 9.3 Codex session modes / approval presets

Modes in Codex map to **approval presets** from `codex_utils_approval_presets::builtin_approval_presets` (cached as `APPROVAL_PRESETS: LazyLock<Vec<ApprovalPreset>>` at codex_agent.rs:105). `set_session_mode` submits `Op::OverrideTurnContext { approval_policy, sandbox_policy, ... }`. When sandbox is `DangerFullAccess` / `WorkspaceWrite` / `ExternalSandbox`, sets project `TrustLevel::Trusted` — `ReadOnly` does not mutate trust level.

**There is no separate "plan" vs "agent" vs "ask" mode in Codex — modes are purely approval presets.** Default depends on codex-core defaults. Preset IDs referenced in code: at least `"read-only"` (L2806).

### 9.4 Codex session config options

All from `config_options()` (L2855-2948):

| Config id           | Category         | Values                                                                               |
| ------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `mode`              | `Mode`           | all preset IDs from `APPROVAL_PRESETS`                                               |
| `model`             | `Model`          | `ModelPreset[]` with `show_in_picker=true` OR currently used                         |
| `reasoning_effort`  | `ThoughtLevel`   | `preset.supported_reasoning_efforts` — only emitted when preset has >1              |

Only `SessionConfigOptionValue::ValueId { value }` accepted — anything else errors with `"Unsupported config option value"`.

### 9.5 Codex MCP integration

- Servers provided at session creation (`NewSessionRequest.mcp_servers`) — merged in `build_session_config` (codex_agent.rs:306-399).
- **Supported:** `McpServerStdio` (mapped with `cwd=config.cwd`), `McpServerHttp` (with optional headers).
- **Silently dropped:** `McpServerSse` (codex_agent.rs:321, comment "Not supported in codex").
- MCP tool approval via `ElicitationRequest` with `meta.codex_approval_kind == "mcp_tool_call"` — see §13.4.
- **Unsupported elicitations auto-declined** — any Form without the codex meta key, and all `Url`-kind elicitations (thread.rs:1445-1459, logs `"Auto-declining unsupported MCP elicitation"`).

### 9.6 Codex replay semantics

- Live `UserMessage` events: log only.
- `replay_history` path (handle_replay_history, L3367-3381) emits `UserMessageChunk` / `AgentMessageChunk` / `AgentThoughtChunk` + completed tool calls from `ResponseItem` items (`FunctionCall`, `FunctionCallOutput`, `LocalShellCall`, `CustomToolCall`, `CustomToolCallOutput`, `WebSearchCall`).
- **Replay events are indistinguishable from live events** on the wire — no `replay: true` marker.
- Replay tool calls use `ToolCallStatus::Completed` directly (no Begin/End pair).
- Special shell tools in replay: `shell`, `container.exec`, `shell_command` parsed via `parse_shell_function_call`; `shell_command` wraps in `bash -lc` for parsing.
- `apply_patch` custom tool in replay: parsed via `parse_apply_patch_call` using `codex_apply_patch::parse_patch`.

### 9.7 Codex quirks

- **`include_apply_patch_tool = true` forced** on every session (codex_agent.rs:312), regardless of client preference.
- **Whitespace in MCP server names** replaced with `_` ("Codex does not allow whitespace", L326/L361).
- **`grant_root` on `ApplyPatchApprovalRequestEvent` always ignored** (thread.rs:1507, comment "doesn't seem to be set anywhere on the codex side").
- **`explanation` in `PlanUpdate` dropped** (thread.rs:1103).
- **`AgentReasoningRawContent`** silently ignored in live events (L1361) but handled in replay (L3400-3402) — inconsistency.
- **`client_info` saved as TODO** (codex_agent.rs:407, `// TODO: save and pass into Codex somehow`) — ClientInfo is dropped.
- **`NO_BROWSER` env** removes ChatGPT auth method (comment: "Until codex device code auth works, we can't use this in remote ssh projects").
- **Custom slash commands** intercepted: `/compact`, `/undo`, `/init`, `/review`, `/review-branch`, `/review-commit`, `/logout`; `/logout` calls `auth.logout()` and returns `Error::auth_required()`. Unrecognized → tries `expand_custom_prompt`.
- **Permission option id collisions** — `"approved"` reused across exec/patch/permissions/MCP elicitation flows; `request_key` prefix (`exec:`/`patch:`/`permissions:`/`mcp-elicitation:`) disambiguates server-side.
- **`DynamicToolCallRequest` and `McpToolCallBegin` have no `kind`** — ACP clients that rely on `ToolKind` for rendering see them as unknown.
- **`show_in_picker` gating** — only "pickable" models surface in select lists unless they equal the current model.

---

## 10. Cursor — exhaustive vocabulary

**Source discipline:** everything below is from `cursor.com/docs/cli/acp`. The
`cursor.com/docs/cli/acp/reference` and `.../cli/reference` pages return 404.
Confidence is **DOCS** throughout — treat as incomplete until validated by
dynamic traces.

### 10.1 Binary / startup

- **Binary name:** `agent`.
- **Command:** `agent acp`.
- **Flags on root `agent`:** `--api-key`, `-e <url>`, `-k`, `--auth-token`.
- **Install:** `curl https://cursor.com/install -fsS | bash` (macOS/Linux/WSL); Windows uses PowerShell. **Exact install path not documented.**
- **Env:** `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`.

### 10.2 Standard ACP methods Cursor implements (documented)

Listed in docs as "Typical ACP session flow":
`initialize`, `authenticate` (methodId `cursor_login`), `session/new`, `session/load`, `session/prompt`, `session/update`, `session/request_permission`, `session/cancel`.

**Not documented** (unknown whether implemented): `session/fork`, `session/resume`, `session/close`, `session/list`, `session/set_mode`, `session/set_model`, `session/set_config_option`, `fs/*`, `terminal/*`, `logout`.

### 10.3 `cursor/*` extension methods — complete inventory

All agent → client. Docs split them into "blocking" (client must respond) vs
"notification" (fire-and-forget), but all five have documented Response
schemas with `outcome` variants, which is internally inconsistent.

#### 10.3.1 `cursor/ask_question` (blocking)

```ts
interface CursorAskQuestionRequest {
  toolCallId: string;
  title?: string;
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
}
interface CursorAskQuestionResponse {
  outcome:
    | { outcome: "answered"; answers: Array<{ questionId: string; selectedOptionIds: string[] }> }
    | { outcome: "skipped"; reason?: string }
    | { outcome: "cancelled" };
}
```

Our handling:
- Registry rules 15 (cursor-question) matches `titles: ["Ask Question", "Ask User", "Question"]` or `names: ["askquestion", "askuser"]`.
- Emits `question` AgentEvent via `extractQuestion` (translate-session-update.ts:228).
- **We lose the per-question `id`** — we use `toolCallId` as the single requestId and aggregate all questions into one `questions[]` array with `{text, options?}` (no `id` field preserved).
- **We lose `allowMultiple`** — our UI assumes single-select.
- **We lose `selectedOptionIds` semantics** — the response schema is for multi-select but our `respondPermission` flow pushes back a single `optionId`.

#### 10.3.2 `cursor/create_plan` (blocking)

```ts
interface CursorCreatePlanRequest {
  toolCallId: string;
  name?: string;
  overview?: string;
  plan: string;    // NOT "markdown"
  todos: Array<{ id; content; status: "pending"|"in_progress"|"completed"|"cancelled" }>;
  isProject?: boolean;
  phases?: Array<{ name: string; todos: Array<{ id; content; status }> }>;
}
interface CursorCreatePlanResponse {
  outcome:
    | { outcome: "accepted"; planUri?: string }
    | { outcome: "rejected"; reason?: string }
    | { outcome: "cancelled" };
}
```

Our handling: **not specifically wired.** No registry rule matches "Create Plan" by title. Falls through to generic intent → shows as a generic tool card. We lose `plan`, `phases`, `isProject`, and the `planUri` on acceptance.

#### 10.3.3 `cursor/update_todos` (nominally notification)

```ts
interface CursorUpdateTodosRequest {
  toolCallId: string;
  todos: Array<{ id; content; status: "pending"|"in_progress"|"completed"|"cancelled" }>;
  merge: boolean;     // true = merge, false = replace
}
interface CursorUpdateTodosResponse {
  outcome: "accepted" with todos[] | "rejected" with reason? | "cancelled";
}
```

Our handling:
- Registry rule 14 (cursor-todos) matches `titles: ["Update TODOs"]` or `names: ["updatetodos"]`.
- Routes via session-surface path → `extractTodos` → `todo-update`.
- **We ignore `merge` flag** — always replaces (our store.ts does `DELETE FROM todo` then re-INSERT).
- **`cancelled` status is not in our todo-status mapping** — `extractTodos` (translate-session-update.ts:186) defaults unknown status to `"in_progress"`.

#### 10.3.4 `cursor/task` (nominally notification)

```ts
interface CursorTaskRequest {
  toolCallId: string;
  description: string;
  prompt: string;
  subagentType:
    | "unspecified" | "computer_use" | "explore" | "video_review"
    | "browser_use" | "shell" | "vm_setup_helper"
    | { custom: string };
  model?: string;
  agentId?: string;
  durationMs?: number;
}
interface CursorTaskResponse {
  outcome:
    | { outcome: "completed"; agentId?: string; durationMs?: number }
    | { outcome: "rejected"; reason?: string }
    | { outcome: "cancelled" };
}
```

Our handling: registry rule 13 (cursor-task) matches `titles: ["Task: Subagent task"]` or `names: ["task"]` → intent `task` → generic tool row.
- **We lose `subagentType`** entirely.
- **We lose `agentId`** (links to a separate session?).
- **We lose `durationMs`**.
- **The `{custom: string}` object variant of subagentType** may not deserialize cleanly through our pathway since it's not a plain string.

#### 10.3.5 `cursor/generate_image` (nominally notification)

```ts
interface CursorGenerateImageRequest {
  toolCallId: string;
  description: string;
  filePath?: string;
  referenceImagePaths?: string[];
}
interface CursorGenerateImageResponse {
  outcome:
    | { outcome: "generated"; filePath: string; imageData?: string }
    | { outcome: "rejected"; reason?: string }
    | { outcome: "cancelled" };
}
```

Our handling: registry rule 16 (cursor-image) matches `titles: ["Generate Image"]` → intent `image` → generic tool row.
- `imageData` presumed base64; docs don't say.
- `referenceImagePaths[]` → opaque blob in `rawInput`; our UI doesn't surface.

### 10.4 Cursor session modes

Only three names documented: `agent` (full tool access), `plan` (planning, read-only), `ask` (Q&A/read-only).

**`session/set_mode` is not documented** on the ACP page. How to switch modes mid-session is unknown from docs.

### 10.5 Cursor permission model

Documented response shape: `{ outcome: { outcome: "selected", optionId: "<one of allow-once|allow-always|reject-once>" } }`.

- Only three outcomes: `allow-once`, `allow-always`, `reject-once`. No `reject-always`.
- **`allow-always` semantics undefined** — docs don't say whether Cursor persists, the client persists, or neither.
- **Our handling** writes `always_json` column but `respondPermission` doesn't verify it suppresses future equivalent prompts (potential bug — see §16).

### 10.6 Cursor MCP

- Config: `.cursor/mcp.json` (project-level or user-level).
- **Team-level MCP servers NOT supported in ACP mode** (explicit docs statement).
- Transport support not documented (likely stdio-only).

### 10.7 Critical docs gaps

These are **unknown behaviors** that traces will resolve:

- Full `agentCapabilities` shape Cursor advertises.
- `promptCapabilities` (image/audio/embeddedContext) — unknown.
- Whether `loadSession` is advertised.
- Error codes returned by any Cursor method.
- Whether `session/fork`, `session/resume`, `session/close`, `session/list` are implemented.
- Whether `set_session_mode` exists as an ACP method (vs only startup flag).
- Session capacity, concurrency caps, rate limits.
- Tool call kinds and statuses Cursor uses.
- FS method names support (`fs/read_text_file`, `fs/write_text_file`).
- Terminal method support (`terminal/*`).
- Full list of SessionUpdate variants (only `agent_message_chunk` named).
- How file references work in prompts (`@` mentions? `resource_link`?).
- Diff representation for edit tools.
- Default model, full available models list.
- Whether cursor proceeds automatically on `"accepted"` plan outcome; what `planUri` contains.
- Account/team semantics for auth (free vs Pro vs team in ACP mode).

---

## 11. Our adapter — complete rule inventory

All 44 rules in `ACP_TOOL_REGISTRY` at `acp-registry.ts:35`. Rules listed by
client. `extractor` field is **a string tag** — no code dispatches on it
(see §12.3).

### 11.1 cursor-acp rules (17)

| # | Titles                                    | Names                        | Kinds        | Intent     | Mode         | Line      |
| - | ----------------------------------------- | ---------------------------- | ------------ | ---------- | ------------ | --------- |
| 1 | `["Terminal"]`                            | —                            | `["execute"]`| `shell`    | —            | 36–44     |
| 2 | `["Read Lints"]`                          | —                            | —            | `lint`     | —            | 45–52     |
| 3 | `["Read File"]`                           | —                            | `["read"]`   | `read`     | —            | 53–61     |
| 4 | `["Edit File"]`                           | —                            | `["edit"]`   | `edit`     | —            | 62–70     |
| 5 | `["Delete File"]`                         | —                            | `["delete"]` | `delete`   | —            | 71–79     |
| 6 | `["Find"]`                                | —                            | `["search"]` | `list`     | `files`      | 80–89     |
| 7 | `["grep"]`                                | —                            | `["search"]` | `search`   | `content`    | 90–99     |
| 8 | `["Web Search"]`                          | —                            | `["search"]` | `search`   | `web`        | 100–109   |
| 9 | `["Codebase Search"]`                     | —                            | `["search"]` | `search`   | `codebase`   | 110–119   |
| 10| `["MCP Tool"]`                            | —                            | —            | `mcp`      | `tool`       | 121–129   |
| 11| `["List MCP Resources"]`                  | —                            | —            | `mcp`      | `list`       | 130–138   |
| 12| `["Fetch MCP Resource"]`                  | —                            | —            | `mcp`      | `fetch`      | 139–147   |
| 13| `["Task: Subagent task"]`                 | `["task"]`                   | —            | `task`     | —            | 148–156   |
| 14| `["Update TODOs"]`                        | `["updatetodos"]`            | —            | `todos`    | —            | 157–165   |
| 15| `["Ask Question","Ask User","Question"]`  | `["askquestion","askuser"]`  | —            | `question` | —            | 166–175   |
| 16| `["Generate Image"]`                      | —                            | —            | `image`    | —            | 176–184   |
| 17| `["Computer Use"]`                        | —                            | —            | `computer` | —            | 185–193   |

### 11.2 codex-acp rules (14)

| # | Titles | Names                                                                 | Kinds         | Intent      | Mode             | Line      |
| - | ------ | --------------------------------------------------------------------- | ------------- | ----------- | ---------------- | --------- |
| 18 | —     | —                                                                     | `["execute"]` | `shell`     | —                | 194–201   |
| 19 | —     | —                                                                     | `["read"]`    | `read`      | —                | 202–209   |
| 20 | —     | —                                                                     | `["edit"]`    | `edit`      | —                | 210–217   |
| 21 | —     | —                                                                     | `["search"]`  | `search`    | —                | 218–225   |
| 22 | —     | `["find"]`                                                            | —             | `list`      | `files`          | 226–234   |
| 23 | —     | —                                                                     | `["fetch"]`   | `fetch`     | —                | 235–242   |
| 24 | —     | `["apply_patch"]`                                                     | —             | `edit`      | `apply_patch`    | 243–252   |
| 25 | —     | `["listfiles"]`                                                       | —             | `list`      | `list`           | 253–262   |
| 26 | —     | `["codesearch"]`                                                      | —             | `search`    | `codebase`       | 263–272   |
| 27 | —     | `["websearch"]`                                                       | —             | `search`    | `web`            | 273–281   |
| 28 | —     | `["openpage"]`                                                        | —             | `fetch`     | `web`            | 282–291   |
| 29 | —     | `["permission"]`                                                      | —             | `question`  | `permission`     | 292–301   |
| 30 | —     | `["mcp","list_mcp_resources","list_mcp_resource_templates","read_mcp_resource"]` | — | `mcp`       | `tool`           | 302–311   |
| 31 | —     | —                                                                     | `["delete"]`  | `delete`    | —                | 312–320   |

### 11.3 claude-acp rules (13)

| # | Titles                                              | Names                    | Kinds       | Intent      | Mode      | Line    |
| - | --------------------------------------------------- | ------------------------ | ----------- | ----------- | --------- | ------- |
| 32| `["Terminal"]`                                      | `["bash"]`               | `["execute"]`| `shell`    | —         | 322–331 |
| 33| `["Read File"]`                                     | `["read"]`               | `["read"]`  | `read`      | —         | 332–341 |
| 34| `["Write"]`                                         | `["write"]`              | —           | `edit`      | `write`   | 342–351 |
| 35| `["Edit File"]`                                     | `["edit"]`               | `["edit"]`  | `edit`      | `edit`    | 352–362 |
| 36| `["Find"]`                                          | `["glob"]`               | —           | `list`      | `glob`    | 363–372 |
| 37| —                                                   | `["grep"]`               | —           | `search`    | `grep`    | 373–381 |
| 38| `["Fetch"]`                                         | `["webfetch"]`           | `["fetch"]` | `fetch`     | `web`     | 382–392 |
| 39| `["Web Search"]`                                    | `["websearch"]`          | —           | `search`    | `web`     | 393–402 |
| 40| `["Update TODOs"]`                                  | `["todowrite"]`          | —           | `todos`     | —         | 403–411 |
| 41| —                                                   | `["exitplanmode"]`       | —           | `reasoning` | `switch`  | 412–420 |
| 42| `["Task"]`                                          | `["agent","task"]`       | —           | `task`      | —         | 421–429 |
| 43| `["ToolSearch"]`                                    | `["toolsearch"]`         | `["other"]` | `generic`   | —         | 430–439 |
| 44| `["Skill","LSP","CronCreate","CronList","CronDelete"]` | —                     | `["other"]` | `generic`   | —         | 440–448 |

**Rule precedence** (`findAcpRule` at acp-registry.ts:458–482): **name > title > kind**. A rule matches if any of its `names`, `titles`, or `kinds` is present and the `client` matches.

**Intent counts by client:**
| Intent      | cursor-acp | codex-acp | claude-acp |
| ----------- | ---------- | --------- | ---------- |
| `shell`     | 1          | 1         | 1          |
| `lint`      | 1          | 0         | 0          |
| `read`      | 1          | 1         | 1          |
| `edit`      | 1          | 2 (24, 20)| 2 (34, 35) |
| `delete`    | 1          | 1         | 0          |
| `list`      | 1          | 2 (22, 25)| 1          |
| `search`    | 3          | 3         | 2          |
| `fetch`     | 0          | 2 (23, 28)| 1          |
| `mcp`       | 3          | 1         | 0          |
| `task`      | 1          | 0         | 1          |
| `todos`     | 1          | 0         | 1          |
| `question`  | 1          | 1         | 0          |
| `image`     | 1          | 0         | 0          |
| `computer`  | 1          | 0         | 0          |
| `reasoning` | 0          | 0         | 1          |
| `generic`   | 0          | 0         | 2          |

---

## 12. Our translator — complete case enumeration

### 12.1 `translateSessionUpdate` switch (translate-session-update.ts:253)

| Case                        | Line       | Emits                                                                                     | Special notes                                                          |
| --------------------------- | ---------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `agent_message_chunk`       | 254        | `step-start` if `messageId` changed (260) + content-type branch (269)                     | Unknown content types → warn + `[]`                                    |
| `agent_thought_chunk`       | 255        | content-type branch with **audio / resource_link dropped** (policy)                       | `resource.text` emits `thinking-delta`                                 |
| `user_message_chunk`        | 307        | `[]` always                                                                               | Intentional — history-replay dedupe                                    |
| `tool_call`                 | 311        | `reduceTool` → `viewTool`. Session-surface path (325) routes `question`/`todos`/`reasoning` out of tool pipeline. Default: `tool-start`, conditional `tool-input`, drainContent, drainSpots | Reasoning intent: suppress tool row, thinking emerges via `agent_thought_chunk` |
| `tool_call_update`          | 356        | Status normalized: `completed`/`failed` pass, `in_progress`→`running`, else `pending`. Session-surface: todos emit `todo-update` only on `completed`/`in_progress` (379). Default status cases fork at 390/402/418. | `pending`/null → `[]` (428)                                       |
| `plan`                      | 432        | single `todo-update`                                                                      | Entries mapped `{id: String(i), description=content, status, priority}` — Claude's `priority` is always `"medium"` from adapter but Codex's is always `Medium` too |
| `available_commands_update` | 442        | `[]`                                                                                      | **Silent drop** — slash commands not surfaced                          |
| `current_mode_update`       | 446        | `session-agent { agentId: update.currentModeId }`                                         |                                                                        |
| `config_option_update`      | 450        | `[mapConfigOptions(update.configOptions)]` → `config-update`                              | Handles both `select` and `boolean`; `flattenSelectOptions` handles grouped |
| `session_info_update`       | 454        | if `title` set: `session-title`; else `[]`                                                | `updatedAt` not surfaced                                               |
| `usage_update`              | 461        | `usage` with `contextSize`, `contextUsed`, optional `cost`                                | `cost.currency` preserved                                              |
| default                     | 473        | `const _: never = update`; warn; `[]`                                                     | Enforces SDK exhaustiveness at compile time                            |

### 12.2 `translateChunkToEvent` (translate-chunk-to-event.ts:260) — 23 cases

| Chunk type               | Line | CompatEvent(s)                                                         | Notable behavior                                             |
| ------------------------ | ---- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `session-status`         | 261  | `sessionError` / `sessionStatus(recovering)` / `sessionStatus`         |                                                              |
| `text-delta`             | 270  | `messagePartUpdated(text)` fresh + `messagePartDelta(text)`            | `textPartSeq` increments on split                            |
| `thinking-delta`         | 273  | `messagePartUpdated(reasoning)` with `time.start` + `messagePartDelta` | `reasoningPartSeq` increments on split                       |
| `tool-start`             | 276  | `messagePartUpdated(tool, status=running)`                             | Registers tool metadata in ctx maps                          |
| `tool-input`             | 300  | `messagePartUpdated(tool)` or `[]` if empty input+metadata             | Calls `normalizeInputKeys` (dual-write camel+snake)          |
| `tool-output`            | 329  | `messagePartUpdated(tool, status=completed, output, time)`             | `output()` helper extracts stdout/stderr for shell intent    |
| `tool-error`             | 356  | `messagePartUpdated(tool, status=error)`                               |                                                              |
| `file-diff`              | 381  | `messagePartUpdated(diff, path, oldText, newText)`                     |                                                              |
| `step-start`             | 393  | `messageCompleted(sessionId, assistantMsgId)`                          | Caller resets `assistantMsgId` after                         |
| `finish`                 | 396  | `messageCompleted` + `sessionIdle`                                     |                                                              |
| `error`                  | 402  | `sessionError(chunk.error)`                                            |                                                              |
| `permission-request`     | 405  | `permissionAsked({id, sessionID, permission=tool, patterns, metadata:{}, always:paths})` | metadata always `{}`                         |
| `question`               | 415  | `questionAsked({id, sessionID, questions})`                            | `questions()` helper shapes `{question, header, options, custom}` |
| `todo-update`            | 422  | **two events:** `todoUpdated` + `sessionTodo`                          | Intentional dual-emit for legacy + new UI                    |
| `image-delta`            | 430  | `messagePartUpdated(image)`                                            |                                                              |
| `audio-delta`            | 441  | `messagePartUpdated(audio)`                                            |                                                              |
| `resource-link-delta`    | 452  | `messagePartUpdated(resource-link)`                                    | Drops `title` field                                          |
| `tool-location`          | 464  | `messagePartUpdated(tool, status=running)` with metadata.acp.locations |                                                              |
| `tool-terminal`          | 489  | completed/error: `messagePartUpdated(terminal, ptyId)` only. Running: both `tool` + `terminal`. |                                            |
| `session-agent`          | 532  | `sessionAgent(sessionId, agentId)`                                     |                                                              |
| `config-update`          | 535  | `sessionConfig({sessionID, options})`                                  |                                                              |
| `session-title`          | 541  | `sessionUpdated(buildSession({id, directory, title}))`                 |                                                              |
| `usage`                  | 548  | `sessionUsage({sessionID, contextSize, contextUsed, cost?})`           |                                                              |
| `subagent-spawned`       | 556  | `[]`                                                                   | **Silent drop** — no nested-session UI                       |
| default                  | 559  | `const _: never = chunk`; `[]`                                         |                                                              |

### 12.3 Where agent identity matters in our code

Registry rules are the primary per-agent surface. Inside the translator,
**no `if (client === ...)` branches exist**. All client-specific logic is
mediated through `findAcpRule` + `intent()` heuristic.

Outside the translator, these file:line branches reference specific agents:

| acp.ts line | Branch                                                                                           | Reason                                         |
| ----------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 65–68       | `MODEL_ENV_VARS`: `claude-agent-acp→ANTHROPIC_MODEL`, `codex-acp→OPENAI_MODEL`                   | env for model override at spawn                |
| 71–76       | `AUTH_ENV_VARS`: claude→`ANTHROPIC_API_KEY`, codex→`OPENAI_API_KEY`, agent/cursor-agent→`CURSOR_API_KEY` | env for API key at spawn               |
| 130         | `if (name !== "claude-agent-acp" && name !== "codex-acp") return direct`                         | Only Claude and Codex use "bun launch" fast-path |
| 275–280     | binary-name → credential: claude→anthropic, codex→openai, else→cursor                            | pick `_acpAuthKeys` entry                      |
| 753–755     | `spawnArgs`: `if (this.options.type !== "cursor-acp") return []` else `["acp"]`                  | Cursor needs `acp` positional                  |
| 1717–1721   | auth config accepts multiple keys: `auth["claude-acp"] ?? auth["anthropic"]` etc.                | Legacy config key compatibility                |

**`pick()` in acp-state.ts:316-465** contains heuristic post-derivation logic
that applies across all agents (not agent-specific). Examples:
- call starts with `mcp__` OR name in MCP set → intent=`mcp` (line 340)
- call==="find" → `list` (lines 344–345)
- call==="codesearch"/"websearch" → `search` (346–347)
- call==="openpage" → `fetch` (348)

### 12.4 `extractor` IDs — tag-only, no dispatch

All 44 rules carry an `extractor` string like `"claude-todos"`, `"codex-shell"`,
`"cursor-grep"`. **No code dispatches on extractor**. The value is copied into
`metadata.acp.extractor` at acp-state.ts:461 for downstream consumers to use
as a label. Present but inert.

---

## 13. Permission & approval models — side-by-side

Each agent has its own approval UX. The SDK defines 4 `PermissionOptionKind`
values (`allow_once`, `allow_always`, `reject_once`, `reject_always`) and a
single `RequestPermissionRequest` shape — but agents extend this richly.

### 13.1 Claude — 3 permission surfaces

**Generic tool permission** (ac-agent:1332-1352, only if `currentModeId !== "bypassPermissions"`):

| optionId        | kind           | label                           |
| --------------- | -------------- | ------------------------------- |
| `allow_always`  | `allow_always` | `"Always Allow"`                |
| `allow`         | `allow_once`   | `"Allow"`                       |
| `reject`        | `reject_once`  | `"Reject"`                      |

**ExitPlanMode** (ac-agent:1274-1286, up to 6 options if `ALLOW_BYPASS`):

| optionId             | kind           | label                                          |
| -------------------- | -------------- | ---------------------------------------------- |
| `bypassPermissions`  | `allow_always` | `"Yes, and bypass permissions"` (gated)        |
| `auto`               | `allow_always` | `"Yes, and use \"auto\" mode"`                 |
| `acceptEdits`        | `allow_always` | `"Yes, and auto-accept edits"`                 |
| `default`            | `allow_once`   | `"Yes, and manually approve edits"`            |
| `plan`               | `reject_once`  | `"No, keep planning"`                          |

On accept: emits `current_mode_update` + calls `updateConfigOption("mode", optionId)`, returns `updatedPermissions`.

**Bypass paths** (no permission request):
- `currentModeId === "bypassPermissions"` — auto-allow with `addRules(toolName, allow, session)` (1322-1330).
- `ALLOW_BYPASS` gate: true unless running as root without `IS_SANDBOX` env.

### 13.2 Codex — 4 approval surfaces

**Exec approval** (thread.rs:1713-1833, from `ExecApprovalRequest`):

Built from server-provided `available_decisions: Vec<ReviewDecision>` via `build_exec_permission_options` (L2221-2326):

| optionId                           | kind           | label                                                                           |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| `approved`                         | `allow_once`   | `"Yes, proceed"` / `"Yes, just this once"` (network-contextual)                 |
| `approved-execpolicy-amendment`    | `allow_always` | `"Yes, and don't ask again for commands that start with \`{prefix}\`"`          |
| `approved-for-session`             | `allow_always` | label varies (network/additional-permissions/plain)                             |
| `network-policy-amendment-allow`   | `allow_always` |                                                                                 |
| `network-policy-amendment-deny`    | `reject_always`|                                                                                 |
| `denied`                           | `reject_once`  | `"No, continue without running it"`                                             |
| `abort`                            | `reject_once`  | `"No, and tell Codex what to do differently"`                                   |

Response shape: `Op::ExecApproval { id: approval_id.unwrap_or(call_id), turn_id, decision: ReviewDecision }`.

**Patch approval** (thread.rs:1496-1543, from `ApplyPatchApprovalRequest`):

Hardcoded 2 options:

| optionId   | kind          | label                       |
| ---------- | ------------- | --------------------------- |
| `approved` | `allow_once`  | `"Yes"`                     |
| `abort`    | `reject_once` | `"No, provide feedback"`    |

Response: `Op::PatchApproval { id: call_id, decision: Approved | Abort }`.

**Permissions grant (RequestPermissions)** (thread.rs:2087-2161):

Hardcoded 3 options:

| optionId                 | kind           |
| ------------------------ | -------------- |
| `approved-for-session`   | `allow_always` |
| `approved`               | `allow_once`   |
| `abort`                  | `reject_once`  |

Scope mapping (thread.rs:918-940):
- `approved-for-session` → `PermissionGrantScope::Session`
- `approved` → `PermissionGrantScope::Turn`
- else/cancel → default empty profile, Turn scope

**MCP elicitation (tool call approval)** (thread.rs:1404-1462):

Triggered by `ElicitationRequest` where `request` is `Form` with `meta.codex_approval_kind == "mcp_tool_call"`. Dynamic options based on `meta.persist`:

| optionId                 | kind           | condition                                |
| ------------------------ | -------------- | ---------------------------------------- |
| `approved`               | `allow_once`   | always                                   |
| `approved-for-session`   | `allow_always` | if `persist` includes `"session"`        |
| `approved-always`        | `allow_always` | if `persist` includes `"always"`         |
| `cancel`                 | `reject_once`  | always                                   |

Response: `Op::ResolveElicitation { server_name, request_id, decision, content, meta }`. `accept_with_persist("session"|"always")` sets `meta = {"persist": ...}`.

**Our handling:** all four Codex approval flows arrive as `session/request_permission` on our side (acp.ts:359). We conflate them into one permission-asked event with `tool` from `toolCall.title` and `paths` from `toolCall.locations`. The `mode` hint on rule 29 (`codex-permission`) differentiates a permission-as-question (reason-based) from a permission-as-tool-approval but the distinction is not surfaced in UI.

### 13.3 Cursor — 3 outcomes

| optionId         | kind           |
| ---------------- | -------------- |
| `allow-once`     | `allow_once`   |
| `allow-always`   | `allow_always` |
| `reject-once`    | `reject_once`  |

**No `reject-always` documented.** `allow-always` persistence semantics undefined.

### 13.4 Our permission pipeline (acp.ts, §13 of adapter survey)

1. Agent emits `requestPermission` → `ClientSideConnection` routes to `clientImpl.requestPermission` at acp.ts:359.
2. We generate `permId = randomUUID()`, store `PendingPermission { aid, tool, paths, options, resolve }` in `pendingPermissions` Map.
3. Look up `permissionPushers.get(sessionId)` (registered per prompt at acp.ts:1223):
   - if pusher: push `permissionAsked` event to outbound stream; UI shows prompt
   - if no pusher (no active prompt): **log warning, permission silently stored but not delivered to UI** (acp.ts:392–395) — potential bug.
4. DB write via `store.appendEvent` → persists to `pending_permission` table (id, session_id, tool, patterns, metadata, always, status).
5. User responds via `ACPAdapter.respondPermission(permId, decision, directory)` (acp.ts:1628–1696):
   - looks up via `store.listPermissions(directory)`
   - writes `permissionReplied` event
   - maps decision via `kindMap: allow_once/allow_always/reject_once/reject_always`
   - finds matching option by kind, falls back to `options[0]`
   - calls `proc.respondPermission(permId, { outcome: { outcome: "selected", optionId: option.optionId } })`
6. Original ACP RPC promise settles, agent receives response.

---

## 14. Interactive state & recovery semantics

### 14.1 Persistent tables (store.ts)

| Table                  | Schema (summary)                                                                   | Lifecycle                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pending_permission`   | id, session_id, tool, patterns_json, metadata_json, always_json, status, timestamps | `permission.asked` → INSERT OR REPLACE; `permission.replied` → DELETE; `process.lost` → mark `status='stale'` |
| `pending_question`     | id, session_id, questions_json, status, timestamps                                 | `question.asked` → INSERT; `question.replied` / `question.rejected` → DELETE; `process.lost` → stale |
| `todo`                 | session_id, position, content, status, priority, updated_at                        | `todo.updated` / `session.todo` → DELETE all + re-INSERT all                              |
| `session`              | id, directory, status (`busy` / `recovering` / ...), recoveryError, timestamps     | `recovery.error` captured for next prompt                                                  |

### 14.2 Translator per-turn state (NOT persisted)

`TranslatorContext.state: SessionState` built fresh on every `sendMessage`:

```
SessionState {
  client, lastMessageId, status, turn,
  tools: Record<toolCallId, ToolState>
}
ToolState {
  id, client, status, title, firstTitle, kind, firstKind, name,
  rawInput, rawOutput, content, locations, terminalId,
  seenDiffs, seenTerms, seenSpots
}
```

`ChunkToEventContext` (translate-chunk-to-event.ts:32) also fresh per turn:
`accumulatedText`, `accumulatedThinkingText`, `toolNamesByCallId`, `partIdMap`,
seq counters, etc.

**All of this evaporates when sendMessage returns.** Cross-turn state is zero.

### 14.3 Failure modes

| Scenario                                        | Adapter behavior                                                                                                                         | UI outcome                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Frontend disconnect (laptop sleep, browser close), adapter + child process alive | `pendingPermissions` Map intact, DB intact. On reconnect, `listPermissions(dir)` filters DB rows to ones still alive in Map. | Works — prompts resume                               |
| Adapter process death (OOM, crash)              | `pendingPermissions` Map evaporates. `process.lost` control event marks DB rows `stale`. `markRecovering(sessionID, ACP_RECOVER)` tags session. | "ACP process restarted; pending interactive state must be rerun" — user must re-run |
| Transport drops but agent alive (future remote ACP scenario) | With `session/resume` now stable, agent can re-emit outstanding `requestPermission` on reconnect. Today we can't exploit this (stdio only, SDK pre-0.16.1 name). | — |
| Mid-turn ACP child dies                         | `sendMessage` iterator breaks. `replace()` boots fresh session. `syncSession` resends prompt. `translatorCtx` discarded. | Partial UI from crashed attempt + full output from retry, no reconciliation |

### 14.4 What `session/resume` (stable 2026-04-22) changes

Once SDK 0.16.1 is bumped and we rename `unstable_resumeSession` → `session/resume`:

- Reconnect → NO replay → translator's fresh context is semantically fine (nothing old coming through to dedupe).
- Eliminates the "replay causes double-emit" class of concerns.
- `session/load` remains as the manual "reopen old session with full replay" fallback.

### 14.5 What `session/close` (stable 2026-04-23) changes

Codex already exposes `close_session`. We don't call it.

- Enables the connection-per-agent refactor: one process hosts many sessions, each individually closable.
- `setModel` / `setAuth` can drain old session without killing process.
- Matches the RFC #1064 transport direction (connection-scoped, session-keyed).

---

## 15. Complete silent-drop inventory

Every location in our code that drops data silently or with only a log
warning. Cross-referenced with whether it's policy or a likely bug.

| File:line                              | What's dropped                                             | Conditions                                                               | Classification                     |
| -------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| translate-session-update.ts:276-279    | `audio` content in `agent_thought_chunk`                   | kind==="agent_thought_chunk" && content.type==="audio"                   | policy (commented)                 |
| translate-session-update.ts:280-290    | `resource_link` content in `agent_thought_chunk`           | kind==="agent_thought_chunk" && content.type==="resource_link"           | policy (commented)                 |
| translate-session-update.ts:291-299    | `BlobResourceContents` (resource.blob) in any chunk        | resource has no `text` field (is blob)                                   | policy but **possible data loss** — binary resources unsupported end-to-end |
| translate-session-update.ts:300-302    | unknown content types                                      | `content.type` not in {text,image,audio,resource_link,resource}          | **ambiguous** — warn-only; SDK addition would break silently |
| translate-session-update.ts:307-309    | all `user_message_chunk` events                            | always                                                                   | **ambiguous policy** — no comment explains; intentional for history-replay dedupe but undocumented |
| translate-session-update.ts:442-444    | all `available_commands_update` events                     | always                                                                   | policy — no UI surface for agent-provided commands |
| translate-session-update.ts:428-429    | `tool_call_update` with status pending/null/undefined       | always                                                                   | policy                             |
| translate-session-update.ts:458        | `session_info_update` with no title                        | `!update.title`                                                          | policy — `updatedAt` not surfaced  |
| translate-session-update.ts:473-477    | unknown SessionUpdate variant                              | default branch                                                           | guard — `const _: never` enforces compile-time; runtime reach = bug |
| acp-state.ts:553                       | Non-diff, non-terminal content items inside tool content   | `item.type !== "terminal"` after diff branch                             | **policy gap** — items stored in state but never emitted |
| translate-chunk-to-event.ts:309        | `tool-input` with empty input AND empty metadata           | Object.keys(input).length===0 && Object.keys(metadata).length===0        | policy — avoid redundant empty updates |
| translate-chunk-to-event.ts:556-557    | `subagent-spawned` chunk                                   | always                                                                   | **ambiguous** — no CompatEvent surface; sub-agents only visible as task tool rows |
| translate-chunk-to-event.ts:559-562    | unknown chunk type                                         | default branch                                                           | guard — `const _: never` enforces compile-time |
| acp.ts:350-355                         | `sessionUpdate` with no listener                           | `!sessionListeners.has(sessionId)` (except `config_option_update` which is cached before this check) | policy — no active stream |
| acp.ts:392-395                         | `requestPermission` delivery without active pusher         | `!permissionPushers.has(sessionId)`                                      | **BUG** — permission stored but never forwarded to UI; respondPermission can still resolve if somehow called |
| acp-registry.ts fall-through           | tools without matching rule                                | `findAcpRule` returns undefined                                          | policy — heuristic `intent()` provides fallback; `metadata.acp.extractor` omitted |
| acp-state.ts various                   | `rawInput` / `rawOutput` fields not in our extractor set   | when `pick()` doesn't recognize a field path                             | pervasive — every agent's `_meta.*` extensions and novel fields | 
| Cursor `subagentType` enum             | `{custom: string}` variant                                 | object-shaped `subagentType` in `cursor/task`                            | **potential runtime bug** — not validated against this shape |
| Cursor `merge: boolean`                | `cursor/update_todos.merge === true`                       | always                                                                   | **BUG** — we always replace, never merge |
| Cursor `allowMultiple: boolean`        | `cursor/ask_question.allowMultiple === true`               | always                                                                   | **BUG** — UI assumes single-select |
| Cursor `phases[]`                      | `cursor/create_plan.phases`                                | always                                                                   | **BUG** — phase structure flattened |
| Cursor `planUri`                       | `cursor/create_plan` accepted outcome                      | always                                                                   | **BUG** — returned value discarded |
| Cursor `subagentType`                  | `cursor/task.subagentType`                                 | always                                                                   | **BUG** — all subagent types flatten to generic task |
| Cursor `agentId`, `durationMs`         | `cursor/task.{agentId, durationMs}`                        | always                                                                   | policy — unused |
| Claude `_meta.claudeCode.parentToolUseId` | subagent parent relationship                            | always                                                                   | **policy gap** — nested-session relationships not surfaced |
| Claude `_meta.claudeCode.toolName`     | canonical tool name on updates                             | always                                                                   | policy — we derive from `title`/`name` heuristically |
| Claude `_meta["terminal-auth"]`        | client-side terminal auth capability                       | we don't advertise                                                       | blocks Claude from offering terminal-auth paths to users |
| Codex `ModelReroute`                   | mid-turn model switch notification                         | always — upstream drops before wire                                      | silent drop upstream; nothing we can fix on our side |
| Codex `StreamError`                    | mid-stream error events                                    | always — upstream drops before wire                                      | silent drop upstream; **potentially serious** |
| Codex `TurnDiff`                       | aggregate diff for the turn                                | always — upstream drops with comment "we already have a way"             | policy upstream                    |
| Codex `BackgroundEvent`                | status updates from Codex                                  | always — upstream TODO                                                   | future surface; logged upstream    |
| Codex `CollabAgent*`, `Realtime*`      | subagent + realtime conversation events                    | always — upstream wildcard with "Subagent UI?" TODO                      | future surface; subagent support blocked on upstream |
| Codex `meta.terminal_output` not flipped | Terminal content vs fenced-code choice                   | we don't advertise `client_capabilities.meta.terminal_output = true`     | degraded-but-functional terminal rendering |

---

## 16. Known bugs and partial implementations

Ordered by severity.

### 16.1 Question reply pipeline has no reply path

`replyQuestion`, `rejectQuestion`, `listQuestions` on `ACPAdapter` (acp.ts:1698–1708) are **no-op stubs** with a comment `// ACP handles questions via permissions`. But:
- `extractQuestion` emits `question-asked` CompatEvents for cursor-question and codex-permission tool calls.
- `pending_question` table is populated on `question.asked`.
- `listQuestions` returns `[]` always.
- No code path ever calls `respondQuestion`-equivalent.

**If the UI calls `replyQuestion`, nothing happens.** Users see a question prompt, answer it, nothing is sent back to the agent. The question tool call hangs until the turn's permission or cancellation path resolves it (if at all).

**File:line:** acp.ts:1698-1708.

### 16.2 Permission stored but not forwarded when no active pusher

At acp.ts:392-395, if `requestPermission` arrives for a session that has no active `permissionPushers` entry (e.g., outside a prompt), we store the permission in `pendingPermissions` Map but **do not emit `permissionAsked` to the UI**. The user never sees the prompt. `respondPermission` could still resolve it if somehow called with the right permId, but there's no way to surface it.

**File:line:** acp.ts:392-395.

### 16.3 Cursor `merge: boolean` on `cursor/update_todos` ignored

`store.ts:615-620` always `DELETE FROM todo WHERE session_id = ?` then re-inserts. When Cursor sends `merge: true`, we should merge by `id` instead of replace. Currently silent-wrong.

**Owner:** store.ts write path + translate-session-update.ts `extractTodos`.

### 16.4 Cursor `allowMultiple` / multi-select answers dropped

`cursor/ask_question.questions[].allowMultiple: boolean` and the response's `answers[].selectedOptionIds: string[]` indicate multi-select. Our `extractQuestion` creates a single-option question and our `respondPermission` returns one `optionId`. Multi-select breaks.

**Owner:** translate-session-update.ts:228 + respondPermission flow.

### 16.5 Cursor plan `phases`, `planUri`, `isProject` discarded

`cursor/create_plan` has no registry rule. It falls through to generic → shown as a plain tool card. `phases` array, `isProject` boolean, and returned `planUri` are all dropped.

**Owner:** new registry rule + new extractor for cursor-create-plan.

### 16.6 Cursor `subagentType` enum flattened

`cursor/task.subagentType` is an 8-variant enum (including `{custom: string}` object form). We don't branch on it. All task types render identically.

**Owner:** registry rule 13 (cursor-task) extractor doesn't carry subagent type; would need to surface in `metadata.acp`.

### 16.7 Claude subagent `parentToolUseId` not threaded

Every inner event from a Claude `Task` tool has `_meta.claudeCode.parentToolUseId`. We don't read it. Inner events appear as unattached top-level tool calls in UI.

**Owner:** acp-state.ts `pick()` should read `_meta.claudeCode.parentToolUseId` into `metadata.acp.parentToolCallId`; downstream UI should nest.

### 16.8 Codex exec/patch/MCP/permissions approvals conflate into one prompt

Four distinct approval semantics all arrive as `requestPermission`. UI shows them identically (tool name + options). Users can't tell "approve shell command" apart from "approve diff apply" apart from "grant session-scoped permission."

**Owner:** UI tier — our metadata has enough hints (`mode==="permission"` vs patch-like content) to differentiate.

### 16.9 `session/close` not called even when supported

Codex advertises `sessionCapabilities.close`. We tear down the whole `ACPProcess` instead. Blocks multi-session-per-process design.

**Owner:** blocker for connection refactor.

### 16.10 `session/resume` still using `unstable_resumeSession` name

Stable since 2026-04-22. Our SDK pin `@agentclientprotocol/sdk@0.16.1` predates stabilization; method call name on client still reads `unstable_resumeSession`. Bumping SDK + renaming call site needed.

**Owner:** SDK bump prerequisite.

### 16.11 Model not passed to Cursor via env

`MODEL_ENV_VARS` has entries for `claude-agent-acp` and `codex-acp`, nothing for `agent`/`cursor-agent`. When we `setModel` a Cursor session, the env at spawn doesn't include it. Cursor uses its own default.

**Owner:** `MODEL_ENV_VARS` or `acp-session.sync` model-setting path.

### 16.12 `cachedConfigOptions` and `sessionListeners` not registered outside prompts

If config options or session updates arrive outside a `sendMessage` call (rare but possible for long-running session config changes), the update is cached or dropped. Not a hot-path bug today but fragile.

---

## 17. Unused agent capabilities we could exploit

Capabilities advertised by agents that we ignore:

### Claude

| Capability                                       | What it enables                                                                                | Our stance              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------- |
| `sessionCapabilities.fork`                        | Persistent fork before prompt for what-if branches                                             | called via `ACPAdapter.forkSession` — OK |
| `sessionCapabilities.list`                        | Agent-hosted session index instead of our SQLite `session_map`                                | **not used**            |
| `sessionCapabilities.close`                       | Per-session teardown without process kill                                                      | **not used**            |
| `_meta.claudeCode.promptQueueing`                 | Allow concurrent `session/prompt` calls; agent queues internally                               | **not used** — we serialize via our `promptQueue` |
| `auth._meta.gateway`                              | Anthropic gateway-based auth (for hosted multi-tenant deploys)                                 | **not used**            |
| `extNotification("_claude/sdkMessage")`           | Raw SDK message mirroring for debug/telemetry                                                  | **not used**            |
| `_meta["terminal-auth"]`                          | Terminal-based auth UX                                                                         | **not advertised**      |

### Codex

| Capability                                       | What it enables                                                                                | Our stance              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------- |
| `list_sessions`                                   | Agent-hosted session list (pagination, title)                                                  | **not called**          |
| `logout`                                          | Agent-side credential invalidation                                                             | **not called**          |
| `close_session`                                   | Per-session teardown                                                                           | **not called**          |
| `AuthAgentCapabilities.logout`                    | Logout capability flag                                                                         | **not read**            |
| `client_capabilities.meta.terminal_output`        | Rich terminal rendering instead of fenced code                                                 | **not advertised**      |
| `set_session_config_option` returns options      | Immediate refreshed option list after change                                                   | not consumed (we call our own getter) |
| `SessionModelState.availableModels`               | Model picker population                                                                        | surfaced via `sessionAgent` + `sessionConfig` events — partial |

### Cursor

| Capability                                       | What it enables                                                                                | Our stance              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------- |
| `cursor/ask_question.allowMultiple`               | Multi-select questions                                                                         | **lost**                |
| `cursor/update_todos.merge`                       | Incremental todo merge                                                                         | **lost**                |
| `cursor/task.subagentType`                        | Differentiate subagent types                                                                   | **lost**                |
| `cursor/task.agentId`                             | Cross-reference subagent session                                                               | **lost**                |
| `cursor/create_plan.{phases, planUri, isProject}` | Plan structure + reference                                                                     | **lost**                |

---

## 18. rawInput/rawOutput field-name drift per agent

The `errorText` helper in translate-session-update.ts:73-110 tries 12+ field
names. This is the mapping of concepts to actual field names per agent.

| Concept                 | Claude (tools.ts)                                             | Codex (thread.rs)                                            | Cursor (docs)                            |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| Shell stdout/stderr     | `bash_code_execution_result.{stdout, stderr}` (Bash result)   | `ExecCommandOutputDelta.chunk` + accumulated; `ExecCommandEnd.exit_code` | `rawOutput.stdout` / `.stderr` (rule 1)  |
| Shell formatted output  | `formatted_output` (editor results only)                      | `formattedOutput`/`formatted_output` in nested `metadata.acp.rawOutput` | not documented                           |
| Aggregated output       | — (Claude uses text blocks)                                   | `aggregated_output`/`aggregatedOutput` on ExecCommandEnd     | not documented                           |
| Exit code               | `bash_code_execution_result.return_code` or `is_error?1:0`    | `ExecCommandEnd.exit_code`                                   | not documented                           |
| Error text              | result block `error_code`/`error_message`                     | `Error.message`, `codex_error_info`                          | not documented                           |
| Terminal id             | `content.terminalId` (when `_meta["terminal-auth"]`)          | `content.terminalId` (when `meta.terminal_output=true`)      | not documented                           |
| Diff body               | `text_editor_code_execution_str_replace_result.lines` OR `content.type="diff"` (Edit/Write) | `content.type="diff"` with `oldText`/`newText` | not documented            |
| File path (tool input)  | `file_path` (Read/Write/Edit)                                 | `filePath` (rule 19/20); `parsed_cmd` gives path for exec    | not documented                           |
| File path (locations)   | `locations[].path`                                            | `locations[].path`                                           | not documented                           |
| Pattern (search)        | `pattern` (Grep, Glob)                                        | `query` (codesearch, websearch); `parsed_cmd.cmd` for grep exec | not documented                        |
| Query (fetch/search)    | `url` (WebFetch), `query` (WebSearch)                         | `url` (openpage), `query`/`queries` (websearch)              | not documented                           |
| Todo list               | `rawInput.todos` — `[{content, status, activeForm}]`          | native `plan` SessionUpdate (not via tool rawInput)          | `rawInput.todos` — `[{id, content, status}]` + `merge` |
| Subagent child session  | — (parent/child via `_meta.claudeCode.parentToolUseId`)       | not observed                                                 | `cursor/task.agentId` on outcome          |
| Tool name (agent side)  | `_meta.claudeCode.toolName`                                   | not forwarded                                                | not documented                           |

Our code reads these via `pick()` in acp-state.ts which tries many field
names per concept. Every new agent adds variants to this dictionary.

---

## 19. Prioritized gaps roadmap

Ordered by leverage × ease.

### Tier 1 — fix existing bugs (no new scope)

1. **Wire `replyQuestion` / `rejectQuestion` to resolve questions** — §16.1. Today UI can ask questions but can't answer them. Either (a) route question reply through the same `respondPermission` machinery (reuse permissionPushers) or (b) implement a parallel questionPushers pipeline.
2. **Handle `cursor/update_todos.merge: true`** — §16.3. One conditional branch in `extractTodos` + store write.
3. **Persist permission request when no pusher is active** so UI can pick it up on reconnect — §16.2. Currently stored but not emitted.
4. **Pass Cursor model via env at spawn** — §16.11. Add `"agent"` and `"cursor-agent"` to `MODEL_ENV_VARS`. Test whether Cursor actually reads that env var.

### Tier 2 — surface lost data

5. **Rule for `cursor/create_plan`** — today falls through to generic. Would need its own intent (`plan`?) or reuse `task` with extractor that reads `phases`, `isProject`, etc.
6. **Surface Cursor `subagentType`** — add to `metadata.acp.subagentType`. UI can render differently later.
7. **Read `_meta.claudeCode.parentToolUseId`** — §16.7. Add to `metadata.acp.parentToolCallId`. UI opportunity, not a pure bug.
8. **Advertise `client_capabilities.meta.terminal_output: true`** — §15. Enables richer Codex terminal rendering. One-line addition in `initialize` client capabilities.

### Tier 3 — protocol alignment

9. **SDK upgrade to pick up stable `session/resume` and `session/close`**. Prerequisite for 10.
10. **Call `session/close` on session deletion** — §16.9. Enables connection-per-agent refactor downstream.
11. **Call `list_sessions` where agents advertise it** — §17 (Claude, Codex). Outsource session discovery to agent; reduces our `session_map` responsibility.

### Tier 4 — observability & correctness

12. **Structured logging at every silent-drop site** — §15 has 15+ drops. Emit `{agent, tool, fieldPath, shape: Object.keys(raw)}` so we can see drift in production.
13. **Schema validation at the SessionUpdate boundary** — zod/valibot parse of SDK types. Malformed fields become observable instead of silently undefined.
14. **Coverage matrix in repo** — `coverage-matrix.json` enumerating every method/variant/capability × each agent × our handling. CI diffs against SDK schema + pinned adapter refs.
15. **Golden-trace harness per agent** — recorded `SessionUpdate[]` fixtures, snapshot-test translator output. Captures real agent behavior vs. assumed behavior.

### Tier 5 — architectural

16. **Connection-per-agent refactor** (`ACPProcess` → `ACPConnection`). §14.5.
17. **Remote ACP client transport** (RFC #1064 Streamable HTTP). Separate track, independent of this document.
18. **Per-agent-version registry rule pinning** — `minVersion` / `maxVersion` on `AcpRule`. Allows supporting multiple agent versions side-by-side.

---

## 20. How to keep this honest

This doc rots at the speed of agent releases. Guardrails:

### Pinned refs

| Runner | Ref                      | Location                                                         |
| ------ | ------------------------ | ---------------------------------------------------------------- |
| Claude | `v0.22.1`                | `agentclientprotocol/claude-agent-acp` (commit at 2026-04-24)    |
| Codex  | `v0.10.0`                | `zed-industries/codex-acp` (commit at 2026-04-24)                |
| Cursor | docs-only (no ref)       | `cursor.com/docs/cli/acp`                                        |
| SDK    | `0.16.1`                 | `@agentclientprotocol/sdk` (npm)                                 |

### Regeneration script

Intended structure for `scripts/survey-acp-source.ts`:

1. Read pinned refs from `packages/workspace-runtime/src/adapters/supported-agents.json` (to be created).
2. For each source-available agent:
   - `git clone --depth 1 --branch {ref}` into a temp dir.
   - Run a TypeScript compiler API walk (Claude) or Rust AST walk (Codex) to extract:
     - Every `sessionUpdate` string literal
     - Every tool case (Claude) / EventMsg variant (Codex)
     - Every ACP method implementation
   - Emit `docs/acp-surveys/{agent}-{ref}.json`.
3. Compare against the tables in this doc. Flag diffs.
4. Fail CI if: variant exists in source but not in this doc; or in doc but not source.

### Compiler-level safety net

`translate-session-update.ts:473` has:
```ts
default: {
  const _: never = update
  log.warn("translateSessionUpdate: unknown variant", { update })
  return []
}
```
When SDK 0.16.2+ adds a new `sessionUpdate` variant, the `const _: never = update`
fails to compile. **Do not silently add a `default` that returns `[]` — always
add a real case.**

### Observability hook

For every silent drop in §15, add a structured log line that can be queried
from telemetry. When a row in the table says "policy", emit INFO. When it
says "ambiguous" or "BUG", emit WARN. Dashboards should track WARN volume
per (agent, drop-site) pair.

---

## 21. Sources

### Agent source repos (commit at 2026-04-24)

- **Claude:** https://github.com/agentclientprotocol/claude-agent-acp
  - `src/tools.ts` (798 lines) — tool-name → ACP mapping
  - `src/acp-agent.ts` (2,548 lines) — full ACP method implementation
  - `src/settings.ts` (313 lines) — settings manager
  - `src/utils.ts`, `src/lib.ts`, `src/index.ts`
- **Codex:** https://github.com/zed-industries/codex-acp
  - `src/codex_agent.rs` (877 lines) — ACP method surface
  - `src/thread.rs` (5,327 lines) — `EventMsg` → ACP translation
  - `src/lib.rs`, `src/main.rs`, `src/prompt_args.rs`
- **Cursor:** https://cursor.com/docs/cli/acp (docs only)
  - Also: https://cursor.com/docs/cli (general CLI)

### SDK

- `@agentclientprotocol/sdk@0.16.1`
  - `schema/schema.json` (843 lines) — complete JSON Schema
  - `dist/acp.d.ts` — TypeScript types

### Protocol references

- ACP docs: https://agentclientprotocol.com/docs
- ACP registry: https://agentclientprotocol.com/get-started/registry
- ACP updates feed (stabilizations): https://agentclientprotocol.com/updates
- RFD #1064 (Streamable HTTP transport): https://github.com/agentclientprotocol/agent-client-protocol/pull/1064

### Our adapter (reviewed in full)

- `packages/workspace-runtime/src/adapters/acp.ts` (1,798 lines) — adapter + ACPProcess class
- `packages/workspace-runtime/src/adapters/acp-session.ts` (295 lines) — session lifecycle
- `packages/workspace-runtime/src/adapters/acp-state.ts` (571 lines) — per-tool state reducer
- `packages/workspace-runtime/src/adapters/acp-registry.ts` (482 lines) — 44 rules
- `packages/workspace-runtime/src/adapters/translate-session-update.ts` (506 lines) — SessionUpdate → AgentEvent
- `packages/workspace-runtime/src/adapters/translate-chunk-to-event.ts` (564 lines) — AgentEvent → CompatEvent
- `packages/workspace-runtime/src/adapters/acp-recovery.ts` (1 line constant)
- `packages/workspace-runtime/src/store.ts` (§14.1 tables)
- `packages/claxedo-server/src/agent-config.ts` (runner type definitions)

### Verification method

Each row in this doc is backed by one of four verification modes (shown in
table headers as a `Conf` column when spot-verification is important):
- **SRC** — agent source code read end-to-end (Claude TS, Codex Rust)
- **SPEC** — SDK JSON Schema or `.d.ts` type definitions
- **DOCS** — vendor documentation only (Cursor)
- **CODE** — our adapter source

Dynamic traces would upgrade DOCS rows to TRACE. No rows are trace-verified
today.
