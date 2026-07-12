// Module-scoped pending-prompt registry for imperative abort controllers. Server
// state lives in Query; this map only tracks non-serializable resources needed to
// cancel one in-flight prompt.
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import {
  dispatchSessionStatusEvent,
  schedulePromptSessionStatusTimeouts,
} from "../store/session-status-dispatcher"

export type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pendingPrompts = new Map<string, PendingPrompt>()

export function registerPendingPrompt(sessionID: string, prompt: PendingPrompt) {
  pendingPrompts.set(sessionID, prompt)
}

export function takePendingPrompt(sessionID: string) {
  const prompt = pendingPrompts.get(sessionID)
  if (!prompt) return
  pendingPrompts.delete(sessionID)
  return prompt
}

export function clearPendingPrompt(sessionID: string) {
  pendingPrompts.delete(sessionID)
}

export function hasPendingPrompt(sessionID: string) {
  return pendingPrompts.has(sessionID)
}

export function pendingPromptCount() {
  return pendingPrompts.size
}

export function clearPendingPromptsForTest() {
  pendingPrompts.clear()
}

export function setPromptSessionStatus(input: {
  sessionID: string
  status: SessionStatus
  source?: "optimistic" | "server"
  refreshDirectory?: VoidFunction
}) {
  dispatchSessionStatusEvent({
    event: {
      type: "session.status",
      source: input.source ?? "optimistic",
      sessionID: input.sessionID,
      status: input.status,
    },
  })
  if ((input.source ?? "optimistic") === "optimistic" && input.status.type !== "idle") {
    schedulePromptSessionStatusTimeouts({
      sessionID: input.sessionID,
      refreshDirectory: input.refreshDirectory,
    })
  }
}
