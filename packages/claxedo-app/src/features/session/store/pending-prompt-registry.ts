// Imports nothing on purpose: the session-status dispatcher reads this registry
// and the submit phase writes to that dispatcher, so any edge out of here would
// close a cycle.

export type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

// Prompts this client has started for a session and the runtime has not yet
// admitted. An entry holding no handle is a prompt already on the wire:
// `prompt_async` answers only after the runtime settles admission, so a local
// cancel from that point on would leave a turn running that the user was told
// had stopped.
const pendingPrompts = new Map<string, PendingPrompt | undefined>()

export function registerPendingPrompt(sessionID: string, prompt: PendingPrompt) {
  pendingPrompts.set(sessionID, prompt)
}

export function markPendingPromptSent(sessionID: string) {
  pendingPrompts.set(sessionID, undefined)
}

/**
 * Claims the pending prompt, returning the abort handle only while cancelling
 * it locally is still possible. The entry goes either way: a caller left to ask
 * the runtime to stop the turn needs the runtime's answer about this session to
 * count again.
 */
export function takePendingPrompt(sessionID: string) {
  const prompt = pendingPrompts.get(sessionID)
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
