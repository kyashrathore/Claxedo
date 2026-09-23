// Low-level send boundary: the actual prompt call into the chosen client.
// Higher-level orchestration (busy state, worktree waits, rollback) lives in
// send.ts.
import type { PromptDelivery } from "@claxedo/agent-runtime-contract"
import { asRecord, readField } from "@/lib/record"
import type { PromptDispatchInput } from "./types"

/**
 * Answers how the runtime took the prompt, when it said so. A prompt that asked
 * nothing about delivery is acknowledged with an empty body, and so is every
 * transport with no runtime behind it.
 */
export async function dispatchPrompt(input: PromptDispatchInput): Promise<PromptDelivery | undefined> {
  const result = await input.client.session.promptAsync(input.payload)
  const delivery = readField(asRecord(readField(asRecord(result), "data")), "delivery")
  return delivery === "steer" || delivery === "queue" || delivery === "start" ? delivery : undefined
}
