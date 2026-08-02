import { createSignal } from "solid-js"

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
