/**
 * The runtime-event subset this app consumes, declared STRUCTURALLY.
 *
 * Deliberately not an import of `@claxedo/agent-event-runtime`: this core must
 * stay dependency-free so the same file runs in the browser and compiles as a
 * Native SDK core (the cores subset has no workspace package resolution).
 * Compatibility with the real contract is enforced by `contract.test.ts`,
 * which type-checks assignability against the canonical `AgentRuntimeEvent`
 * union — a drift there is a test failure, not a silent divergence.
 *
 * Events outside this subset are ignored by the fold on purpose: the timeline
 * renders what it understands and stays forward-compatible with new types.
 */

export type RuntimeStatus = "busy" | "idle" | "error" | "recovering"
export type RuntimeToolStatus = "pending" | "running" | "completed" | "failed"
export type RuntimeNoticeSeverity = "debug" | "info" | "warn" | "error"

export type ToolDisplaySubset = {
  kind?: string
  summary?: string
  description?: string
  command?: string
  path?: string
  filePath?: string
}

export type RuntimeEventSubset =
  | { type: "text-delta"; delta: string }
  | { type: "thinking-delta"; delta: string }
  | { type: "step-start"; newMessageId: string }
  | { type: "tool-start"; toolCallId: string; toolName: string; display?: ToolDisplaySubset }
  | { type: "tool-status"; toolCallId: string; status: RuntimeToolStatus; display?: ToolDisplaySubset }
  | { type: "tool-error"; toolCallId: string; error: string; display?: ToolDisplaySubset }
  | { type: "session-status"; status: RuntimeStatus }
  | { type: "session-title"; title: string }
  | { type: "session-info"; title?: string | null; updatedAt?: string | null }
  | { type: "harness-notice"; code: string; message: string; severity?: RuntimeNoticeSeverity }
  | { type: "todo-update"; todos: Array<{ id: string; description: string; status: string }> }
  | { type: "proposed-plan-delta"; delta: string }
  | { type: "proposed-plan-complete"; planMarkdown: string }
  | { type: "finish"; sessionId: string }
  | { type: "error"; error: string }

/** Anything with a `type` — the fold narrows to the subset and ignores the rest. */
export type AnyRuntimeEvent = { type: string } & Record<string, unknown>

/** The SSE envelope shape from `/api/wr/runtime-events`. */
export type RuntimeEventEnvelope = {
  sessionId: string
  directory: string
  payload: AnyRuntimeEvent
}
