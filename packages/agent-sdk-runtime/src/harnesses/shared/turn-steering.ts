import type { SteerResult } from "../../adapter-contract"
import type { PromptInput } from "../../index"
import type { ActiveTurn } from "./sdk-runtime-driver"
import { errorMessage } from "./sdk-runtime-values"
import type { SessionTurnLifecycle } from "./turn-lifecycle"

/**
 * Hands a prompt to the turn running for this session.
 *
 * Steering is a property of the TURN, not of the harness: the driver registers
 * `steer` on its lifecycle entry only once the protocol it opened can accept
 * more input, so a harness that cannot steer and a turn that cannot yet steer
 * answer the same way and the runtime queues both.
 */
export async function steerActiveTurn(
  lifecycle: SessionTurnLifecycle<ActiveTurn>,
  sessionId: string,
  input: PromptInput,
): Promise<SteerResult> {
  const turn = lifecycle.get(sessionId)
  if (!turn) return { ok: false, status: "no_active_turn", message: `Session ${sessionId} has no running turn` }
  if (!turn.steer) return { ok: false, status: "declined", message: "This turn does not accept more input" }
  try {
    await turn.steer(input)
    return { ok: true }
  } catch (error) {
    return { ok: false, status: "failed", message: errorMessage(error) }
  }
}
