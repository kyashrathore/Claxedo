/**
 * The session model — Elm-shaped on purpose.
 *
 * This file is the L1 layer from the dual-target plan (sub-plan 03): plain
 * TypeScript in the cores subset, no DOM, no imports beyond siblings. The
 * browser runs it as-is; the Native SDK build compiles it. Rows are derived
 * INSIDE the fold so views on both targets stay dumb — a view only ever maps
 * `rows` to widgets and dispatches messages.
 */

import type { RuntimeNoticeSeverity, RuntimeStatus, RuntimeToolStatus } from "./events"

export type TimelineRow =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; markdown: string; streaming: boolean }
  | { kind: "thinking"; id: string; markdown: string; streaming: boolean }
  | {
      kind: "tool"
      id: string
      toolCallId: string
      name: string
      status: RuntimeToolStatus
      summary?: string
      error?: string
    }
  | { kind: "notice"; id: string; severity: RuntimeNoticeSeverity; message: string }
  | { kind: "plan"; id: string; markdown: string; complete: boolean }
  | { kind: "todos"; id: string; todos: Array<{ id: string; description: string; status: string }> }

export type ConnectionState = "connecting" | "live" | "closed" | "error"

export type SessionModel = {
  sessionId: string
  directory: string
  title?: string
  status: RuntimeStatus
  connection: ConnectionState
  rows: TimelineRow[]
  draft: string
  /** Set while a submitted prompt is awaiting the turn to start. */
  sending: boolean
  lastError?: string
}

/** A transcript message as returned by `GET /session/:id/message`, decoded tolerantly. */
export type TranscriptMessage = {
  id: string
  role: "user" | "assistant"
  text: string
}

export type SessionMsg =
  | { type: "RuntimeEvent"; event: { type: string } & Record<string, unknown> }
  | { type: "TranscriptLoaded"; messages: TranscriptMessage[] }
  | { type: "ConnectionChanged"; state: ConnectionState }
  | { type: "DraftEdited"; text: string }
  | { type: "SubmitPrompt" }
  | { type: "PromptAccepted"; userMessageId?: string }
  | { type: "PromptFailed"; error: string }

/**
 * Side effects the shells execute. `update` never performs I/O — it returns
 * the effect and the shell (web or native) runs it through its ports, feeding
 * results back as messages. This is the seam that keeps the core identical on
 * both targets.
 */
export type SessionEffect = { kind: "send-prompt"; sessionId: string; directory: string; text: string }

export type UpdateResult = { model: SessionModel; effects: SessionEffect[] }

export function initSessionModel(input: { sessionId: string; directory: string; title?: string }): SessionModel {
  return {
    sessionId: input.sessionId,
    directory: input.directory,
    ...(input.title !== undefined ? { title: input.title } : {}),
    status: "idle",
    connection: "connecting",
    rows: [],
    draft: "",
    sending: false,
  }
}
