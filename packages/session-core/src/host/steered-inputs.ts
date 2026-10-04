import type { SteeredInput } from "../projection/turn-projection"

/**
 * Prompts handed to a running turn, from the steer until the harness reports
 * where its conversation took them in. Keyed by the turn's admission
 * generation, so an input addressed to one turn can never be written into
 * another, and whatever a turn never incorporated goes with it.
 */
export function createSteeredInputs() {
  const byTurn = new WeakMap<object, Map<string, SteeredInput>>()
  return {
    /** Registered before the transport is asked, because a harness can report the input before the steer call returns. */
    expect(generation: object, input: SteeredInput) {
      const inputs = byTurn.get(generation) ?? new Map<string, SteeredInput>()
      inputs.set(input.userMessageId, input)
      byTurn.set(generation, inputs)
    },
    forget(generation: object, messageId: string) {
      byTurn.get(generation)?.delete(messageId)
    },
    take(generation: object, messageId: string): SteeredInput | undefined {
      const inputs = byTurn.get(generation)
      const input = inputs?.get(messageId)
      inputs?.delete(messageId)
      return input
    },
  }
}

export type SteeredInputs = ReturnType<typeof createSteeredInputs>
