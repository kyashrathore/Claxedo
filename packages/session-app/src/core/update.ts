/**
 * The one `update` function — every state change in the session app flows
 * through here, on both targets.
 *
 * Structural sharing discipline: rows other than the one being touched keep
 * their object identity, so the web bridge's keyed diff (and any renderer's
 * memoization) sees exactly one changed row per event. Streaming perf on both
 * targets depends on this — treat identity preservation as a contract, and
 * `update.test.ts` pins it.
 */

import type { RuntimeEventSubset } from "./events"
import type { SessionEffect, SessionModel, SessionMsg, TimelineRow, TranscriptMessage, UpdateResult } from "./model"

export function update(model: SessionModel, msg: SessionMsg): UpdateResult {
  switch (msg.type) {
    case "RuntimeEvent":
      return { model: applyRuntimeEvent(model, msg.event), effects: [] }
    case "TranscriptLoaded":
      return { model: { ...model, rows: transcriptRows(msg.messages) }, effects: [] }
    case "ConnectionChanged":
      return { model: { ...model, connection: msg.state }, effects: [] }
    case "DraftEdited":
      return { model: { ...model, draft: msg.text }, effects: [] }
    case "SubmitPrompt": {
      const text = model.draft.trim()
      if (!text || model.sending) return { model, effects: [] }
      return {
        model: {
          ...model,
          draft: "",
          sending: true,
          rows: [...model.rows, { kind: "user", id: `local-${model.rows.length}`, text }],
        },
        effects: [{ kind: "send-prompt", sessionId: model.sessionId, directory: model.directory, text }],
      }
    }
    case "PromptAccepted":
      return { model: { ...model, sending: false }, effects: [] }
    case "PromptFailed":
      return {
        model: {
          ...model,
          sending: false,
          rows: [...model.rows, notice(model, "error", msg.error)],
        },
        effects: [],
      }
  }
}

const none: SessionEffect[] = []
void none

/**
 * Folds one runtime event into the model. Unknown event types return the model
 * UNCHANGED (same reference) so no renderer does any work for them — the
 * forward-compatibility half of the contract subset in `events.ts`.
 */
export function applyRuntimeEvent(model: SessionModel, raw: { type: string } & Record<string, unknown>): SessionModel {
  const event = raw as unknown as RuntimeEventSubset
  switch (event.type) {
    case "step-start":
      return appendRow(model, { kind: "assistant", id: event.newMessageId, markdown: "", streaming: true })
    case "text-delta":
      return appendToStreamingRow(model, "assistant", event.delta)
    case "thinking-delta":
      return appendToStreamingRow(model, "thinking", event.delta)
    case "tool-start":
      return upsertToolRow(model, event.toolCallId, () => ({
        kind: "tool",
        id: `tool-${event.toolCallId}`,
        toolCallId: event.toolCallId,
        name: event.toolName,
        status: "pending",
        ...(event.display?.summary ? { summary: event.display.summary } : {}),
      }))
    case "tool-status":
      return upsertToolRow(model, event.toolCallId, (existing) => ({
        ...(existing ?? missingToolRow(event.toolCallId)),
        status: event.status,
        ...(event.display?.summary ? { summary: event.display.summary } : {}),
      }))
    case "tool-error":
      return upsertToolRow(model, event.toolCallId, (existing) => ({
        ...(existing ?? missingToolRow(event.toolCallId)),
        status: "failed",
        error: event.error,
      }))
    case "session-status":
      return event.status === model.status ? model : { ...model, status: event.status }
    case "session-title":
      return { ...model, title: event.title }
    case "session-info":
      return event.title != null ? { ...model, title: event.title } : model
    case "harness-notice":
      return appendRow(model, notice(model, event.severity ?? "info", event.message))
    case "todo-update":
      return upsertSingletonRow(model, "todos", { kind: "todos", id: "todos", todos: event.todos })
    case "proposed-plan-delta": {
      const existing = model.rows.find((row): row is Extract<TimelineRow, { kind: "plan" }> => row.kind === "plan" && !row.complete)
      return upsertSingletonRow(model, "plan", {
        kind: "plan",
        id: existing?.id ?? "plan",
        markdown: (existing?.markdown ?? "") + event.delta,
        complete: false,
      })
    }
    case "proposed-plan-complete":
      return upsertSingletonRow(model, "plan", { kind: "plan", id: "plan", markdown: event.planMarkdown, complete: true })
    case "finish":
      return {
        ...model,
        status: "idle",
        rows: model.rows.map((row) =>
          (row.kind === "assistant" || row.kind === "thinking") && row.streaming ? { ...row, streaming: false } : row,
        ),
      }
    case "error":
      return { ...appendRow(model, notice(model, "error", event.error)), status: "error", lastError: event.error }
    default:
      return model
  }
}

/** Seeds rows from a stored transcript (`GET /session/:id/message`). */
export function transcriptRows(messages: TranscriptMessage[]): TimelineRow[] {
  return messages.flatMap((message): TimelineRow[] => {
    if (!message.text) return []
    return message.role === "user"
      ? [{ kind: "user", id: message.id, text: message.text }]
      : [{ kind: "assistant", id: message.id, markdown: message.text, streaming: false }]
  })
}

/**
 * Tolerant decoder for the transcript endpoint's `{info, parts}` records.
 * Defensive by design: it extracts what the timeline renders and drops the
 * rest, so a harness-specific part shape can never break loading.
 */
export function decodeTranscript(input: unknown): TranscriptMessage[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item): TranscriptMessage[] => {
    if (!item || typeof item !== "object") return []
    const record = item as { info?: Record<string, unknown>; parts?: unknown[] }
    const info = record.info ?? {}
    const id = typeof info.id === "string" ? info.id : undefined
    const role = info.role === "user" || info.role === "assistant" ? info.role : undefined
    if (!id || !role) return []
    const text = (record.parts ?? [])
      .flatMap((part) => {
        if (!part || typeof part !== "object") return []
        const p = part as { type?: unknown; text?: unknown }
        return p.type === "text" && typeof p.text === "string" ? [p.text] : []
      })
      .join("")
    return [{ id, role, text }]
  })
}

function notice(model: SessionModel, severity: Extract<TimelineRow, { kind: "notice" }>["severity"], message: string): TimelineRow {
  return { kind: "notice", id: `notice-${model.rows.length}`, severity, message }
}

function appendRow(model: SessionModel, row: TimelineRow): SessionModel {
  return { ...model, rows: [...model.rows, row] }
}

/**
 * Appends a delta to the LAST streaming row of the kind, creating one when the
 * stream starts without a `step-start` (some harnesses do).
 */
function appendToStreamingRow(model: SessionModel, kind: "assistant" | "thinking", delta: string): SessionModel {
  for (let i = model.rows.length - 1; i >= 0; i--) {
    const row = model.rows[i]
    if (row.kind === kind && row.streaming) {
      const rows = model.rows.slice()
      rows[i] = { ...row, markdown: row.markdown + delta }
      return { ...model, rows }
    }
    // A streaming row of the OTHER kind ends the search window: deltas after a
    // new step belong to that step, never to an older row above it.
    if ((row.kind === "assistant" || row.kind === "thinking") && row.streaming) break
  }
  return appendRow(model, { kind, id: `${kind}-${model.rows.length}`, markdown: delta, streaming: true })
}

function missingToolRow(toolCallId: string): Extract<TimelineRow, { kind: "tool" }> {
  return { kind: "tool", id: `tool-${toolCallId}`, toolCallId, name: "tool", status: "pending" }
}

function upsertToolRow(
  model: SessionModel,
  toolCallId: string,
  build: (existing: Extract<TimelineRow, { kind: "tool" }> | undefined) => Extract<TimelineRow, { kind: "tool" }>,
): SessionModel {
  const index = model.rows.findIndex((row) => row.kind === "tool" && row.toolCallId === toolCallId)
  if (index === -1) return appendRow(model, build(undefined))
  const rows = model.rows.slice()
  rows[index] = build(model.rows[index] as Extract<TimelineRow, { kind: "tool" }>)
  return { ...model, rows }
}

/** Rows that exist at most once (todos, the active plan), replaced in place. */
function upsertSingletonRow(model: SessionModel, kind: "todos" | "plan", row: TimelineRow): SessionModel {
  const index = model.rows.findIndex((existing) => existing.kind === kind)
  if (index === -1) return appendRow(model, row)
  const rows = model.rows.slice()
  rows[index] = row
  return { ...model, rows }
}
