// Low-level send boundary: the actual prompt calls into
// the chosen client. Higher-level orchestration (busy state, worktree waits,
// rollback) lives in send.ts.
import type { PromptDispatchInput } from "./types"

export async function dispatchPrompt(input: PromptDispatchInput) {
  if (input.demo) {
    const response = await input.client.session.prompt(input.payload)
    if (response.error) throw response.error
    const reply = response.data
    if (reply?.info && reply.parts) input.onDemoReply(reply)
    return
  }
  await input.client.session.promptAsync(input.payload)
}
