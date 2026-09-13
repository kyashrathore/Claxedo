import type { HarnessInstructionChannel } from "@claxedo/agent-runtime-contract"

/** UTF-8 bytes. The block is stored whole and delivered whole. */
export const SESSION_INSTRUCTIONS_MAX_BYTES = 64 * 1024

export function sessionInstructionsByteLength(instructions: string): number {
  return new TextEncoder().encode(instructions).length
}

export type SessionInstructionsRefusal = {
  reason: "no_instruction_channel" | "too_large"
  message: string
}

/**
 * The one admission for a session's standing instruction block, shared by both
 * create paths so neither can accept what the other refuses.
 *
 * A harness with no instruction channel is refused rather than handed a block
 * it would drop, and an oversized block is refused by byte count rather than
 * trimmed: losing the tail of what the session was told is worse than the
 * create failing with a reason. The caller decides how to answer.
 */
export function admitSessionInstructions(input: {
  /** Named in the refusal when the caller knows which harness it asked for. */
  harness?: string
  channel: HarnessInstructionChannel
  instructions: string | undefined
}): SessionInstructionsRefusal | undefined {
  if (!input.instructions) return undefined
  if (input.channel === "none") {
    return {
      reason: "no_instruction_channel",
      message: `${input.harness ? `Harness ${input.harness}` : "This harness"} has no instruction channel for session instructions`,
    }
  }
  if (sessionInstructionsByteLength(input.instructions) > SESSION_INSTRUCTIONS_MAX_BYTES) {
    return {
      reason: "too_large",
      message: `Session instructions must be at most ${SESSION_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes`,
    }
  }
  return undefined
}
