#!/usr/bin/env bun
/**
 * Generates e2e/fixtures/harness-traces/<harness>.json for
 * e2e/playwright/core-harness-rendering-matrix.spec.ts.
 *
 * WHY THIS SCRIPT EXISTS:
 * the rendering-matrix spec must replay each harness family's REAL translated event
 * trace through the mocked SSE stream, not a hand-invented one. This script is the
 * single source of truth for those traces: it runs the ACTUAL production code from
 * `@claxedo/agent-event-runtime` (the harness adapters + the opencode-compat
 * projection — the same pipeline claxedo-server runs in production, see
 * packages/workspace-runtime/src/session/service.ts) over RAW harness event payloads
 * copied/composed from that package's OWN test fixtures:
 *   - packages/agent-event-runtime/src/harnesses/acp/golden-compat.test.ts
 *   - packages/agent-event-runtime/src/harnesses/acp/event-translator.test.ts
 *   - packages/agent-event-runtime/src/harnesses/claude/adapter.test.ts
 *   - packages/agent-event-runtime/src/harnesses/codex/adapter.test.ts
 *   - packages/agent-event-runtime/src/harnesses/cursor/adapter.test.ts
 *
 * The RAW payloads below are copied from (or are minor recombinations of) those
 * files' `agent.ingest({...})` calls — never hand-invented compat/SSE shapes. Only the
 * translation OUTPUT is generated (never hand-edited) by actually running the adapter
 * + projection code, per DoD #4 ("a script regenerates them; hand-edited fixtures are
 * rejected").
 *
 * TWO DOCUMENTED EXCEPTIONS (no adapter exists to derive from):
 *   - "opencode" (native harness): there is no packages/agent-event-runtime adapter
 *     for it — `find packages/agent-event-runtime/src/harnesses` has no opencode
 *     directory — because opencode's own SSE events ARE the target compat shape
 *     already (nothing to translate). Its trace is authored directly as literal
 *     CompatEnvelope objects matching the exact shape `createOpencodeCompatProjection`
 *     produces for every other harness (see OPENCODE_NATIVE_TRACE below).
 *   - "pi": there is no pi-specific code anywhere under packages/agent-event-runtime
 *     either (grep confirmed zero hits). Per project memory, Pi is a fixed-model
 *     harness built on the same opencode engine, so it speaks the native opencode
 *     compat format directly too. Its trace reuses the opencode-native generator with
 *     a reduced scenario (Pi's spec 10 coverage only needs to prove it shares the
 *     native rendering path, not repeat the full matrix — see the spec's SPEC block).
 *
 * ONE DELIBERATE POST-GENERATION AUGMENTATION (documented, not a hand-invented shape):
 * the real `subagent-updated` AgentRuntimeEvent is intentionally dropped by the
 * opencode-compat projection (`case "subagent-updated": return []` in projection.ts) —
 * child-session correlation for the `task` tool card happens client-side via a
 * session-list lookup (`taskSession()` in message-part.tsx) that this fixture harness
 * cannot reproduce (it would require a second live session in the store). To still
 * prove the task-tool's child-link affordance (SPEC behavior 15), this script injects
 * `state.metadata.sessionId` directly onto the COMPLETED task tool part after real
 * generation — the one hand-touched field in this entire file, called out here and in
 * the spec's HARNESS NOTES. See `injectTaskChildSessionId` below.
 *
 * Run: `bun run e2e/fixtures/generate-harness-fixtures.ts` from packages/claxedo-app.
 * Commit the resulting JSON under e2e/fixtures/harness-traces/.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createAgentEventRuntime, type HarnessEventAdapter } from "@claxedo/agent-event-runtime"
import { createOpencodeCompatProjection } from "@claxedo/agent-event-runtime/opencode-compat"
import { createAcpEventTranslator } from "@claxedo/agent-event-runtime/harnesses/acp"
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"
import { codexAppServerAdapter } from "@claxedo/agent-event-runtime/harnesses/codex"
import { cursorSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/cursor"

type RawEvent = { source: string; method?: string; payload: unknown }
type CompatEnvelope = { directory: string; payload: { type: string; properties?: unknown; id?: string } }

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "harness-traces")

// Fixed per-harness identity so the committed JSON slots directly into the spec's
// mock-runtime session without any runtime string surgery. `msg_assistant_1` matches
// `installMockRuntime`'s own `msg_assistant_${promptCount}` convention for a turn's
// first send (see e2e/helpers/mock-runtime.ts `driveTurn`) — the spec replays each
// trace ONTO that same, already-oracle-proven assistant message.
function identity(harness: string) {
  return {
    sessionId: `ses_harness_matrix_${harness}`,
    directory: `/tmp/e2e-core-harness-rendering-matrix-${harness}`,
    assistantMessageId: "msg_assistant_1",
  }
}

function runAdapter<State>(input: {
  harness: string
  adapter: HarnessEventAdapter<State>
  raw: RawEvent[]
}): CompatEnvelope[] {
  const { sessionId, directory, assistantMessageId } = identity(input.harness)
  const runtime = createAgentEventRuntime({
    harness: input.harness,
    threadId: "thread-1",
    adapter: input.adapter,
    // Deterministic, monotonic — keeps the committed JSON stable across regenerations.
    clock: (() => {
      let tick = 0
      return () => (tick += 10)
    })(),
    createId: (() => {
      let next = 0
      return (prefix = "id") => `${prefix}-${next++}`
    })(),
  })
  const projection = createOpencodeCompatProjection({
    sessionId,
    directory,
    assistantMessageId,
    clock: (() => {
      let tick = 1000
      return () => (tick += 10)
    })(),
  })
  const envelopes: CompatEnvelope[] = []
  for (const event of input.raw) {
    const { events } = runtime.ingest(event)
    for (const runtimeEvent of events) {
      envelopes.push(...(projection.ingest(runtimeEvent) as CompatEnvelope[]))
    }
  }
  return envelopes
}

/**
 * The one hand-touched field in this file — see the file header's "ONE DELIBERATE
 * POST-GENERATION AUGMENTATION" note. Finds the completed `task` tool part in an
 * already-generated trace and stamps a child session id onto its `state.metadata`,
 * matching exactly what `taskId()` in packages/session-ui/src/components/
 * message-part.tsx reads (`part().state?.metadata.sessionId`).
 */
function injectTaskChildSessionId(envelopes: CompatEnvelope[], childSessionId: string) {
  for (const envelope of envelopes) {
    if (envelope.payload.type !== "message.part.updated") continue
    const part = (envelope.payload.properties as { part?: Record<string, unknown> } | undefined)?.part
    if (!part || part.type !== "tool" || part.tool !== "task") continue
    const state = part.state as Record<string, unknown> | undefined
    if (!state || state.status !== "completed") continue
    const metadata = { ...((state.metadata as Record<string, unknown>) ?? {}), sessionId: childSessionId }
    state.metadata = metadata
    part.metadata = metadata
  }
  return envelopes
}

// ---------------------------------------------------------------------------
// claude-acp — raw ACP session/update payloads, harvested from
// harnesses/acp/event-translator.test.ts ("emits only unseen assistant text...",
// "preserves tool output evidence...") and harnesses/acp/registry.ts's claude-acp
// rules (Terminal->bash, "Read File"->read, "Task"->task, "Update TODOs"->todowrite).
// ---------------------------------------------------------------------------
const CLAUDE_ACP_RAW: RawEvent[] = [
  // Cumulative-snapshot text dedup (behavior 1): second chunk repeats the first's
  // prefix — only the NEW suffix should become a text-delta.
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "Building the " } },
  },
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "Building the feature now." } },
  },
  // Terminal -> bash normalization (behavior 16) + evidence preserved through a
  // completion whose own rawOutput is null (behavior 3/5 lifecycle).
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call", toolCallId: "tool-bash-1", title: "Terminal", kind: "execute", rawInput: { command: "printf hi" } },
  },
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call_update", toolCallId: "tool-bash-1", status: "in_progress", rawOutput: { stdout: "hi" } },
  },
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call_update", toolCallId: "tool-bash-1", status: "completed", rawOutput: null },
  },
  // "Read File" -> read (behavior 3).
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-read-1",
      title: "Read File",
      kind: "read",
      rawInput: { filePath: "src/index.ts" },
      locations: [{ path: "src/index.ts", line: 3 }],
    },
  },
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call_update", toolCallId: "tool-read-1", status: "completed", rawOutput: { content: "export const x = 1" } },
  },
  // "Task" -> task, subagent tool (behavior 15).
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-task-1",
      title: "Task",
      rawInput: { description: "Review the auth module", subagent_type: "code-reviewer" },
    },
  },
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call_update", toolCallId: "tool-task-1", status: "completed" },
  },
  // "Update TODOs" -> todowrite, never a tool row (behavior 9).
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-todo-1",
      title: "Update TODOs",
      rawInput: { todos: [{ content: "Ship the fix", status: "completed" }, { content: "Write tests", status: "in_progress" }] },
    },
  },
]

// ---------------------------------------------------------------------------
// codex-acp — raw ACP payloads: the exact Permission trace from golden-compat.test.ts
// ("maps a representative Codex ACP trace...") plus an apply_patch tool_call using the
// registry's `names: ["apply_patch"]` discriminator (see registry.ts + state.ts's
// `name()` extraction from rawInput._toolName/toolName/tool/name).
// ---------------------------------------------------------------------------
const CODEX_ACP_RAW: RawEvent[] = [
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "Patching the config." } },
  },
  // Codex's fake "Permission" tool -> permission.asked (dock), never a tool row
  // (behavior 12) — payload copied verbatim from golden-compat.test.ts.
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: {
      sessionUpdate: "tool_call",
      toolCallId: "permission-1",
      title: "Permission",
      rawInput: { tool: "shell", reason: "Needs access", scopes: ["/repo"] },
    },
  },
  // apply_patch tool_call. VERIFIED-REAL FINDING (not asserted as "apply_patch" —
  // see the spec's HARNESS NOTES): registry.ts's codex-acp rule sets
  // `short: "apply_patch", intent: "edit"`, but state.ts's `pick()` unconditionally
  // does `if (nextIntent === "edit") short = "edit"` (line ~496) AFTER the registry
  // lookup, with no exception for mode==="apply_patch". So Codex ACP's apply_patch
  // tool_call actually renders through the generic "edit" ToolRegistry entry, not a
  // dedicated "apply_patch" one — this trace intentionally proves THAT real behavior.
  // The dedicated "apply_patch" renderer (multi-file accordion) IS proven separately
  // via the opencode-native trace below, where opencode's own built-in tool is
  // literally named "apply_patch".
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-patch-1",
      rawInput: { _toolName: "apply_patch", filePath: "src/app.ts", diff: "@@ -1 +1 @@\n-old\n+new" },
    },
  },
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call_update", toolCallId: "tool-patch-1", status: "completed" },
  },
  // bash via kind-only classification (no title needed for codex-acp's rule).
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call", toolCallId: "tool-bash-1", kind: "execute", rawInput: { command: "git status" } },
  },
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call_update", toolCallId: "tool-bash-1", status: "completed", rawOutput: { stdout: "clean" } },
  },
]

// ---------------------------------------------------------------------------
// codex-app-server (native) — raw payloads from harnesses/codex/adapter.test.ts
// ("maps reasoning and proposed plan streams", "completes tool-like items...",
// "reports app-server methods that have no runtime mapping").
// ---------------------------------------------------------------------------
const CODEX_APP_SERVER_RAW: RawEvent[] = [
  { source: "codex.app-server", method: "item/agentMessage/delta", payload: { itemId: "msg-1", delta: "Inspecting the repo." } },
  { source: "codex.app-server", method: "item/reasoning/textDelta", payload: { delta: "Checking test coverage first." } },
  // Codex plan stream renders as ORDINARY TEXT (behavior 11 — no plan part/dock).
  { source: "codex.app-server", method: "item/plan/delta", payload: { delta: "- inspect tests\n" } },
  { source: "codex.app-server", method: "item/completed", payload: { item: { id: "plan-1", type: "plan", text: "- inspect tests\n- run suite" } } },
  // Native tool naming ("command") does not match any ToolRegistry key -> GenericTool
  // fallback (behavior 4) — this is the native/SDK counterpart contrast to ACP's
  // Terminal->bash normalization (behavior 16 is ACP-only, see HARNESS NOTES).
  {
    source: "codex.app-server",
    method: "item/completed",
    payload: { item: { id: "cmd-1", type: "commandExecution", command: "git status", cwd: "/repo", output: "clean" } },
  },
  // Diagnostics never render as a message row (behavior 17).
  { source: "codex.app-server", method: "hook/started", payload: { threadId: "thread-1", turnId: "turn-1", run: { id: "hook-1" } } },
]

// ---------------------------------------------------------------------------
// cursor-acp — raw payloads from event-translator.test.ts's "emits only unseen
// assistant text..." (reused shape) and "drops Cursor ACP writable-iterable
// transport tail text" (verbatim), plus Terminal->bash and Update TODOs.
// ---------------------------------------------------------------------------
const CURSOR_ACP_RAW: RawEvent[] = [
  // Cumulative full-text snapshot dedup (behavior 13).
  { source: "acp.jsonrpc", method: "session/update", payload: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "A" } } },
  { source: "acp.jsonrpc", method: "session/update", payload: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "A1" } } },
  // The sentinel tail is swallowed entirely — zero events (behavior 14), verbatim
  // from event-translator.test.ts.
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "\n\nError: RetriableError: WritableIterable is closed" } },
  },
  // Terminal -> bash (behavior 16).
  { source: "acp.jsonrpc", method: "session/update", payload: { sessionUpdate: "tool_call", toolCallId: "tool-bash-1", title: "Terminal", kind: "execute", rawInput: { command: "ls" } } },
  { source: "acp.jsonrpc", method: "session/update", payload: { sessionUpdate: "tool_call_update", toolCallId: "tool-bash-1", status: "completed", rawOutput: { stdout: "file.ts" } } },
  // "Task: Subagent task" -> task, child link (behavior 15).
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call", toolCallId: "tool-task-1", title: "Task: Subagent task", rawInput: { description: "Investigate flaky test" } },
  },
  { source: "acp.jsonrpc", method: "session/update", payload: { sessionUpdate: "tool_call_update", toolCallId: "tool-task-1", status: "completed" } },
  // "Update TODOs" -> todowrite, never a tool row (behavior 9).
  {
    source: "acp.jsonrpc",
    method: "session/update",
    payload: { sessionUpdate: "tool_call", toolCallId: "tool-todo-1", title: "Update TODOs", rawInput: { todos: [{ content: "Fix flake", status: "in_progress" }] } },
  },
]

// ---------------------------------------------------------------------------
// cursor-sdk (native) — raw payloads from harnesses/cursor/adapter.test.ts ("maps
// assistant snapshots without duplicating restored text", "maps tool call lifecycle
// events", "routes UpdateTodos and Task tools to first-class runtime events").
// ---------------------------------------------------------------------------
const CURSOR_SDK_RAW: RawEvent[] = [
  { source: "cursor.sdk.message", payload: { type: "assistant", agent_id: "agent-1", run_id: "run-1", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } } },
  { source: "cursor.sdk.message", payload: { type: "assistant", agent_id: "agent-1", run_id: "run-1", message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] } } },
  // Raw native tool name "shell" does not match the ToolRegistry -> GenericTool
  // fallback (behavior 4; contrast with cursor-acp's ACP-normalized "Terminal"->bash).
  {
    source: "cursor.sdk.message",
    payload: { type: "tool_call", agent_id: "agent-1", run_id: "run-1", call_id: "tool-shell-1", name: "shell", status: "completed", args: { command: "bun test", workingDirectory: "/repo" }, result: { status: "success", value: { exitCode: 0, stdout: "passed", stderr: "" } } },
  },
  // updateTodos intercepted -> never a tool row (behavior 9).
  {
    source: "cursor.sdk.message",
    payload: { type: "tool_call", agent_id: "agent-1", run_id: "run-1", call_id: "todo-1", name: "updateTodos", status: "completed", args: { todos: [{ content: "Ship adapter", status: "inProgress" }] } },
  },
]

// ---------------------------------------------------------------------------
// claude-sdk (native) — raw payloads from harnesses/claude/adapter.test.ts ("maps
// reasoning deltas, streamed tool inputs, and tool results", "routes TodoWrite input
// to todo updates", "reports SDK events that have no AgentRuntimeEvent mapping").
// ---------------------------------------------------------------------------
const CLAUDE_SDK_RAW: RawEvent[] = [
  { source: "claude.sdk.message", payload: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Searching the repo." } } } },
  { source: "claude.sdk.message", payload: { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Let me check the grep results." } } } },
  // Raw native tool name "Grep" (capitalized, Anthropic's own convention) does not
  // match the ToolRegistry's lowercase "grep" key -> GenericTool fallback
  // (behavior 4; contrast with claude-acp's ACP-normalized "grep").
  { source: "claude.sdk.message", payload: { type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool-grep-1", name: "Grep", input: {} } } } },
  { source: "claude.sdk.message", payload: { type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"TODO\",\"path\":\"src\"}" } } } },
  { source: "claude.sdk.message", payload: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-grep-1", content: "src/example.ts:1:TODO" }] } } },
  // TodoWrite is intercepted before it ever becomes a tool-start -> never a tool row
  // (behavior 9).
  { source: "claude.sdk.message", payload: { type: "stream_event", event: { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "tool-todo-1", name: "TodoWrite", input: {} } } } },
  { source: "claude.sdk.message", payload: { type: "stream_event", event: { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"todos\":[{\"content\":\"Ship it\",\"status\":\"completed\"}]}" } } } },
  // Diagnostics never render as a message row (behavior 17).
  { source: "claude.sdk.message", payload: { type: "stream_event", event: { type: "content_block_delta", index: 4, delta: { type: "citations_delta", citation: { type: "webpage", url: "https://example.com" } } } } },
]

// ---------------------------------------------------------------------------
// opencode (native) + pi — hand-authored CompatEnvelope literals. Documented
// exception (see file header): there is no agent-event-runtime adapter for either,
// because this already IS the target shape. Every field below matches the exact
// shapes `createOpencodeCompatProjection` produces for the other six harnesses
// (cross-checked against projection.ts's `toolPart`/`toolState`/`partEvent`
// helpers and packages/session-ui/src/components/message-part.tsx's readers).
// ---------------------------------------------------------------------------
function opencodeNativeTrace(harness: "opencode" | "pi"): CompatEnvelope[] {
  const { sessionId, directory, assistantMessageId } = identity(harness)
  const msg = assistantMessageId
  const env = (payload: CompatEnvelope["payload"]): CompatEnvelope => ({ directory, payload })
  const part = (p: Record<string, unknown>, time: number) =>
    env({ type: "message.part.updated", properties: { sessionID: sessionId, part: p, time } })

  const full = [
    part({ id: `${msg}-text`, sessionID: sessionId, messageID: msg, type: "text", text: "" }, 100),
    env({ type: "message.part.delta", properties: { sessionID: sessionId, messageID: msg, partID: `${msg}-text`, field: "text", delta: "Reading the config, then editing it." } }),
    // reasoning — gated client-side by showReasoningSummaries (behavior 2).
    part({ id: `${msg}-reasoning`, sessionID: sessionId, messageID: msg, type: "reasoning", text: "First read the file to see its current shape.", time: { start: 110 } }, 110),
    // read (behavior 3).
    part(
      {
        id: `${msg}-read`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-read-1", tool: "read",
        state: { status: "completed", input: { filePath: "config.json" }, output: "{}", title: "read", metadata: {}, time: { start: 120, end: 130 } },
      },
      130,
    ),
    // list (behavior 3).
    part(
      {
        id: `${msg}-list`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-list-1", tool: "list",
        state: { status: "completed", input: { path: "src" }, output: "index.ts\nconfig.json", title: "list", metadata: {}, time: { start: 130, end: 140 } },
      },
      140,
    ),
    // glob (behavior 3).
    part(
      {
        id: `${msg}-glob`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-glob-1", tool: "glob",
        state: { status: "completed", input: { pattern: "**/*.json", path: "." }, output: "config.json", title: "glob", metadata: {}, time: { start: 140, end: 150 } },
      },
      150,
    ),
    // webfetch (behavior 3).
    part(
      {
        id: `${msg}-webfetch`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-webfetch-1", tool: "webfetch",
        state: { status: "completed", input: { url: "https://example.com/docs" }, output: "docs", title: "webfetch", metadata: {}, time: { start: 150, end: 160 } },
      },
      160,
    ),
    // websearch (behavior 3).
    part(
      {
        id: `${msg}-websearch`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-websearch-1", tool: "websearch",
        state: { status: "completed", input: { query: "opencode config schema" }, output: "https://example.com/docs", title: "websearch", metadata: { provider: "exa" }, time: { start: 160, end: 170 } },
      },
      170,
    ),
    // write (behavior 3).
    part(
      {
        id: `${msg}-write`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-write-1", tool: "write",
        state: { status: "completed", input: { filePath: "config.json", content: "{\"ok\":true}" }, output: "", title: "write", metadata: {}, time: { start: 170, end: 180 } },
      },
      180,
    ),
    // skill (behavior 3).
    part(
      {
        id: `${msg}-skill`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-skill-1", tool: "skill",
        state: { status: "completed", input: { name: "pdf" }, output: "done", title: "skill", metadata: {}, time: { start: 180, end: 190 } },
      },
      190,
    ),
    // apply_patch (behavior 3 + 16's dedicated-renderer half — opencode's own
    // built-in tool is literally named "apply_patch"; see the CODEX_ACP_RAW comment
    // above for why Codex ACP's own apply_patch tool_call does NOT reach this
    // renderer in the current source).
    part(
      {
        id: `${msg}-apply-patch`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-apply-patch-1", tool: "apply_patch",
        state: {
          status: "completed",
          input: { files: [{ filePath: "src/app.ts", diff: "@@ -1 +1 @@\n-old\n+new" }] },
          output: "", title: "apply_patch",
          metadata: { files: [{ filePath: "src/app.ts", relativePath: "src/app.ts", type: "update", patch: "@@ -1 +1 @@\n-old\n+new" }] },
          time: { start: 191, end: 194 },
        },
      },
      194,
    ),
    // compaction divider (behavior 7).
    part({ id: `${msg}-compaction`, sessionID: sessionId, messageID: msg, type: "compaction" }, 195),
    // GenericTool fallback for a genuinely unregistered tool name (behavior 4).
    part(
      {
        id: `${msg}-custom`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-custom-1", tool: "custom_mcp_tool",
        state: { status: "completed", input: { query: "vector search" }, output: "3 hits", title: "custom_mcp_tool", metadata: {}, time: { start: 195, end: 200 } },
      },
      200,
    ),
    // question tool: PENDING (hidden — behavior 10, part 1 of 2).
    part(
      {
        id: `${msg}-question`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-question-1", tool: "question",
        state: { status: "pending", input: { questions: [{ question: "Which environment should I target?" }] }, raw: "{}" },
      },
      205,
    ),
  ]

  return full
}

function opencodeNativeQuestionAnswered(harness: "opencode" | "pi"): CompatEnvelope {
  const { sessionId, directory, assistantMessageId } = identity(harness)
  const msg = assistantMessageId
  return {
    directory,
    payload: {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        time: 210,
        part: {
          id: `${msg}-question`, sessionID: sessionId, messageID: msg, type: "tool", callID: "tool-question-1", tool: "question",
          state: {
            status: "completed",
            input: { questions: [{ question: "Which environment should I target?" }] },
            output: "",
            title: "question",
            metadata: { answers: [["staging"]] },
            time: { start: 205, end: 210 },
          },
          metadata: { answers: [["staging"]] },
        },
      },
    },
  }
}

/** Staged pending -> running -> completed -> error bash lifecycle (behavior 5). */
function opencodeNativeLifecycleStages(harness: "opencode" | "pi") {
  const { sessionId, directory, assistantMessageId } = identity(harness)
  const msg = assistantMessageId
  const partAt = (status: "pending" | "running" | "completed" | "error", time: number): CompatEnvelope => {
    const base = { id: `${msg}-lifecycle`, sessionID: sessionId, messageID: msg, type: "tool" as const, callID: "tool-lifecycle-1", tool: "bash" }
    if (status === "pending") return { directory, payload: { type: "message.part.updated", properties: { sessionID: sessionId, time, part: { ...base, state: { status: "pending", input: { command: "bun test" }, raw: "{}" } } } } }
    if (status === "running") return { directory, payload: { type: "message.part.updated", properties: { sessionID: sessionId, time, part: { ...base, state: { status: "running", input: { command: "bun test" }, time: { start: time } } } } } }
    if (status === "completed") return { directory, payload: { type: "message.part.updated", properties: { sessionID: sessionId, time, part: { ...base, state: { status: "completed", input: { command: "bun test" }, output: "12 pass", title: "bash", metadata: {}, time: { start: time - 10, end: time } } } } } }
    return { directory, payload: { type: "message.part.updated", properties: { sessionID: sessionId, time, part: { ...base, state: { status: "error", input: { command: "bun test" }, error: "exit code 1", time: { start: time - 10, end: time } } } } } }
  }
  return {
    pending: partAt("pending", 300),
    running: partAt("running", 310),
    completed: partAt("completed", 320),
    error: partAt("error", 330),
  }
}

/** session.diff must never create a phantom message row (behavior 8, supplementary). */
function opencodeNativeSessionDiff(harness: "opencode" | "pi"): CompatEnvelope {
  const { sessionId, directory } = identity(harness)
  return {
    directory,
    payload: {
      type: "session.diff",
      properties: { sessionID: sessionId, diff: [{ file: "config.json", additions: 1, deletions: 0, status: "modified" }] },
    },
  }
}

// ---------------------------------------------------------------------------
// Build + write
// ---------------------------------------------------------------------------

function build() {
  const claudeAcp = runAdapter({ harness: "claude-acp", adapter: createAcpEventTranslator({ client: "claude-acp" }), raw: CLAUDE_ACP_RAW })
  injectTaskChildSessionId(claudeAcp, "ses_child_claude_task")

  const codexAcp = runAdapter({ harness: "codex-acp", adapter: createAcpEventTranslator({ client: "codex-acp" }), raw: CODEX_ACP_RAW })

  const cursorAcp = runAdapter({ harness: "cursor-acp", adapter: createAcpEventTranslator({ client: "cursor-acp" }), raw: CURSOR_ACP_RAW })
  injectTaskChildSessionId(cursorAcp, "ses_child_cursor_task")

  const codexAppServer = runAdapter({ harness: "codex-app-server", adapter: codexAppServerAdapter(), raw: CODEX_APP_SERVER_RAW })
  const cursorSdk = runAdapter({ harness: "cursor-sdk", adapter: cursorSdkAdapter(), raw: CURSOR_SDK_RAW })
  const claudeSdk = runAdapter({ harness: "claude-sdk", adapter: claudeSdkAdapter(), raw: CLAUDE_SDK_RAW })

  const opencode = {
    main: opencodeNativeTrace("opencode"),
    questionAnswered: opencodeNativeQuestionAnswered("opencode"),
    lifecycle: opencodeNativeLifecycleStages("opencode"),
    sessionDiff: opencodeNativeSessionDiff("opencode"),
  }
  const pi = {
    // Pi's coverage is intentionally reduced — see file header. Reuse the same
    // generator; the spec only replays a text reply + one dedicated tool renderer
    // for it. The first 4 native envelopes are text `.updated`, text `.delta`,
    // reasoning `.updated`, and the `read` tool (`config.json` subtitle) — enough
    // to prove both that Pi shares the native text path (behavior 1) and that a
    // Pi tool part reaches its dedicated ToolRegistry renderer (behavior 3).
    main: opencodeNativeTrace("pi").slice(0, 4),
  }

  return {
    "claude-acp": { envelopes: claudeAcp },
    "codex-acp": { envelopes: codexAcp },
    "cursor-acp": { envelopes: cursorAcp },
    "codex-app-server": { envelopes: codexAppServer },
    "cursor-sdk": { envelopes: cursorSdk },
    "claude-sdk": { envelopes: claudeSdk },
    opencode,
    pi,
  }
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const fixtures = build()
  for (const [harness, data] of Object.entries(fixtures)) {
    const path = join(OUT_DIR, `${harness}.json`)
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
    console.log(`wrote ${path}`)
  }
}

main()
