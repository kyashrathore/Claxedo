import type { HarnessSession, TurnInput, TurnRef } from "../../../contract"
import type { AcpEntry } from "../index"
import { acpPrompt } from "../protocol"
import { acpGroups } from "./groups"

export function acpSteerOperations(entryFor: (session: HarnessSession) => AcpEntry) {
  return { steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
    const entry = entryFor(session)
    if (!acpGroups(entry.peer.handshake).steer) return { ok: false as const, status: "unsupported" as const, message: "ACP steer extension is unavailable" }
    if (entry.phase !== "busy") return { ok: false as const, status: "no_active_turn" as const, message: "ACP turn is not active" }
    const result = await entry.peer.agent.extMethod("session/steer", { sessionId: session.binding.upstreamSessionId, prompt: acpPrompt(input) })
    return result.ok === true ? { ok: true as const } : { ok: false as const, status: "declined" as const,
      message: typeof result.message === "string" ? result.message : "ACP agent declined steering" }
  } }
}
