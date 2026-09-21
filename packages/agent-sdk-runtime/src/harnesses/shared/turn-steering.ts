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
 * more input. Missing support is explicit; transport errors after dispatch
 * remain unknown until provider evidence resolves them.
 */
export async function steerActiveTurn(
  lifecycle: SessionTurnLifecycle<ActiveTurn>,
  sessionId: string,
  input: PromptInput,
): Promise<SteerResult> {
  const turn = lifecycle.get(sessionId)
  if (!turn) return { ok: false, status: "no_active_turn", message: `Session ${sessionId} has no running turn` }
  if (!turn.steer) return { ok: false, status: "unsupported", message: "This turn does not support steering" }
  try {
    return await turn.steer(input)
  } catch (error) {
    // A disconnected transport does not prove that the provider rejected input.
    return { ok: false, status: "unknown", message: errorMessage(error) }
  }
}
