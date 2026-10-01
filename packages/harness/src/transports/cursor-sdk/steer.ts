import type { SteerResult } from "@claxedo/agent-runtime-contract"
import type { TurnInput } from "../../contract"
import type { CursorEntry } from "./entry"
import { cursorSteerUnanswered } from "./errors"
import type { CursorHost } from "./host-registry"
import { cursorPrompt } from "./turn"

const IDLE = { ok: false, status: "no_active_turn", message: "No Cursor turn is active" } as const satisfies SteerResult

export async function steerCursorTurn(entry: CursorEntry, host: CursorHost | undefined, input: TurnInput): Promise<SteerResult> {
  if (!entry.busy || !host) return IDLE
  const prompt = await cursorPrompt(input, entry.input.directory)
  const reply = await host.call({ kind: "steer", sessionId: entry.session.binding.sessionId, text: typeof prompt === "string" ? prompt : prompt.text })
  const outcome = reply.kind === "result" ? reply.value?.steer : undefined
  switch (outcome) {
    case "complete_delivered":
      return { ok: true }
    case "revert_to_followup":
      return { ok: false, status: "declined", message: "Cursor did not take the steer into its running turn" }
    case "no_run":
      return IDLE
    case "unsupported":
      return { ok: false, status: "unsupported", message: "This Cursor run does not accept steering" }
    default:
      throw cursorSteerUnanswered()
  }
}
