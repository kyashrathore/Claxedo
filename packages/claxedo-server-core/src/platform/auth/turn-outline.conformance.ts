import type { TurnOutline } from "../../session/turn-outline"
import type { PrivateSessionAuthority } from "./private-session-authority"
import type { SessionTurnAuthority } from "./session-turn-authority"
import type { SessionPageConformanceUser } from "./session-page.conformance"

export type TurnOutlineConformanceHarness = {
  authority: PrivateSessionAuthority & SessionTurnAuthority
  workspaceId: string
  creator: SessionPageConformanceUser
}

type Outline = TurnOutline & { allowed: boolean }

const syncedMessage = (id: string, role: "user" | "assistant", parts: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  info: { id, role, time: { created: Number(id.replace(/\D/g, "")) * 10, completed: Number(id.replace(/\D/g, "")) * 10 + 5 }, ...extra },
  parts,
})

/**
 * A registry's answer to the outline of the transcript it stores: every turn of
 * the window, oldest first, with the prompt cut to a snippet. A session with
 * no transcript outlines as complete and empty.
 */
export async function exerciseTurnOutlineConformance(harness: TurnOutlineConformanceHarness) {
  const { authority, workspaceId, creator } = harness
  const sessionId = "ses_turn_outline"
  await authority.reserveSession(creator.auth, { operationId: "op_turn_outline", sessionId, workspaceId, kind: "create" })
  await authority.registerRuntimeSession({ ...creator.runtime, operationId: "op_turn_outline", sessionId, workspaceId })
  const read = async () => (await authority.readSessionOutline(creator.auth, { sessionId, workspaceId })) as Outline
  const empty = await read()
  outlineHolds(empty.allowed && empty.turns.length === 0 && empty.complete, "an empty transcript did not outline as complete and empty")

  const runtime = { ...creator.runtime, sessionId, workspaceId }
  const admit = async (turnId: string) => {
    const lease = await authority.acquireSessionTurn({ ...runtime, turnId })
    await authority.releaseSessionTurn({ ...runtime, turnId, leaseId: lease.leaseId, fencingToken: lease.fencingToken })
    return lease
  }
  await admit("u1")
  const lease = await admit("u2")
  await authority.syncSessionMessages(creator.auth, {
    sessionId,
    workspaceId,
    maxEventOrdinal: 5,
    fencingToken: lease.fencingToken,
    messages: [
      syncedMessage("u1", "user", [{ type: "text", text: "  first\n\nprompt " }], { summary: { title: "First" } }),
      syncedMessage("a1", "assistant", [{ type: "text", text: "first answer, at length past the snippet" }], { parentID: "u1" }),
      syncedMessage("u2", "user", [{ type: "text", text: "second" }]),
      syncedMessage("a2-tool", "assistant", [{ type: "tool", tool: "Agent", callID: "call-agent", state: { status: "completed", input: {}, output: "x".repeat(2048) } }], { parentID: "u2" }),
      syncedMessage("a2", "assistant", [{ type: "reasoning", text: "thinking" }, { type: "text", text: "second answer" }], { parentID: "u2" }),
    ],
  })

  const outline = await read()
  outlineHolds(outline.allowed && outline.complete, "a whole transcript did not outline as complete")
  outlineHolds(
    JSON.stringify(outline.turns) === JSON.stringify([
      { id: "u1", createdAt: 10, title: "First", user: "first prompt" },
      { id: "u2", createdAt: 20, user: "second" },
    ]),
    "the turns' titles, times or prompt snippets are wrong",
  )
  return outline.turns.map((turn) => turn.id)
}

function outlineHolds(condition: unknown, text: string): asserts condition {
  if (!condition) throw new Error(`Turn-outline conformance failed: ${text}`)
}
