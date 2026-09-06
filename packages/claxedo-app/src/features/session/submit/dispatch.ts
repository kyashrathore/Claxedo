// Low-level send boundary: the actual prompt call into the chosen client.
// Higher-level orchestration (busy state, worktree waits, rollback) lives in
// send.ts.
import type { PromptDispatchInput } from "./types"

export async function dispatchPrompt(input: PromptDispatchInput) {
  await input.client.session.promptAsync(input.payload)
}
