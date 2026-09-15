import type { AgentRuntimePromptPayload } from "@/platform/runtime/agent/agent-runtime-client"
import { AgentRuntimeRequestError } from "@/platform/runtime/agent/agent-runtime-request-error"
import { queryClient } from "@/platform/query/query-client"
import type { QueuedMessageEdit } from "@/features/session/providers/prompt"
import { QUEUED_MESSAGES_QUERY_KEY } from "@/features/session/queue/queued-messages-controller"

/**
 * A send while the composer holds a queued message's text swaps that message's
 * parts in place instead of queueing a second one. Resolves false when the
 * runtime no longer has the message (409), which is the caller's cue to send
 * the draft as a new message; any other failure keeps the draft and reports.
 */
export async function replaceQueuedPrompt(input: {
  edit: QueuedMessageEdit
  parts: AgentRuntimePromptPayload["parts"]
  replace: (input: { seq: number; parts: AgentRuntimePromptPayload["parts"] }) => Promise<void>
  clearEdit: VoidFunction
  clearInput: VoidFunction
  showFailed: (err: unknown) => void
}): Promise<boolean> {
  try {
    await input.replace({ seq: input.edit.seq, parts: input.parts })
  } catch (err) {
    if (err instanceof AgentRuntimeRequestError && err.status === 409) {
      input.clearEdit()
      return false
    }
    input.showFailed(err)
    return true
  }
  input.clearEdit()
  input.clearInput()
  void queryClient.invalidateQueries({ queryKey: [QUEUED_MESSAGES_QUERY_KEY] })
  return true
}
