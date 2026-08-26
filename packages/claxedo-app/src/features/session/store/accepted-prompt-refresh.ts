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
let claim: { sequence: number; owner: object } | undefined
let completedSequence = 0

export function requestAcceptedPromptRefresh(input: Omit<AcceptedPromptRefresh, "sequence">) {
  sequence += 1
  setAcceptedPromptRefresh({ ...input, sequence })
}

export function acceptedPromptRefreshRequest() {
  return acceptedPromptRefresh()
}

/** One mounted controller owns a submitted prompt's reconciliation lifecycle. */
export function claimAcceptedPromptRefresh(request: AcceptedPromptRefresh, owner: object) {
  if (request.sequence <= completedSequence) return false
  if (claim && (claim.sequence !== request.sequence || claim.owner !== owner)) return false
  claim = { sequence: request.sequence, owner }
  return true
}

export function releaseAcceptedPromptRefresh(request: AcceptedPromptRefresh, owner: object) {
  if (claim?.sequence === request.sequence && claim.owner === owner) claim = undefined
}

export function completeAcceptedPromptRefresh(request: AcceptedPromptRefresh, owner: object) {
  if (claim?.sequence !== request.sequence || claim.owner !== owner) return false
  claim = undefined
  completedSequence = Math.max(completedSequence, request.sequence)
  if (acceptedPromptRefresh()?.sequence === request.sequence) setAcceptedPromptRefresh(undefined)
  return true
}

export function resetAcceptedPromptRefreshForTest() {
  claim = undefined
  completedSequence = 0
  setAcceptedPromptRefresh(undefined)
}

export function acceptedPromptRefreshMatches(input: {
  request?: Pick<AcceptedPromptRefresh, "sessionID" | "directory">
  sessionID?: string
  currentDirectory: AcceptedPromptRefresh["directory"]
}) {
  return !!input.request && input.request.sessionID === input.sessionID && input.request.directory === input.currentDirectory
}

export function promptRefreshDelay(delay: number, signal?: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false)
    const timer = setTimeout(() => resolve(true), delay)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve(false)
    }, { once: true })
  })
}

export async function readAcceptedPromptStatus(input: {
  sessionID: string
  signal?: AbortSignal
  client: {
    session: {
      status: (
        parameters?: { directory?: string; workspace?: string },
        options?: { signal?: AbortSignal },
      ) => Promise<{ data?: Record<string, SessionStatus> }>
    }
  }
}) {
  const result = await input.client.session.status(undefined, { signal: input.signal }).catch(() => undefined)
  if (input.signal?.aborted) return
  if (!result?.data) return
  return result.data[input.sessionID] ?? idleSessionStatus
}
