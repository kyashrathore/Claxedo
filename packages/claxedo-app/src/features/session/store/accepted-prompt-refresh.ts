import { createSignal } from "solid-js"
import { idleSessionStatus } from "./session-store"
import type { SessionStatusDispatchEvent } from "./session-status-dispatcher"

type SessionStatus = NonNullable<Extract<SessionStatusDispatchEvent, { type: "session.status" }>["status"]>

export type AcceptedPromptRefresh = {
  sequence: number
  directory: string
  sessionID: string
  messageID: string
}

let sequence = 0
const [acceptedPromptRefresh, setAcceptedPromptRefresh] = createSignal<AcceptedPromptRefresh>()

export function requestAcceptedPromptRefresh(input: Omit<AcceptedPromptRefresh, "sequence">) {
  sequence += 1
  setAcceptedPromptRefresh({ ...input, sequence })
}

export function acceptedPromptRefreshRequest() {
  return acceptedPromptRefresh()
}

export async function readAcceptedPromptStatus(input: {
  sessionID: string
  client: { session: { status: () => Promise<{ data?: Record<string, SessionStatus> }> } }
}) {
  const result = await input.client.session.status().catch(() => undefined)
  if (!result?.data) return
  return result.data[input.sessionID] ?? idleSessionStatus
}
