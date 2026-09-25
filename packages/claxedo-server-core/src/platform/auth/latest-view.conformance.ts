import type { PrivateSessionAuthority } from "./private-session-authority"
import type { SessionTurnAuthority } from "./session-turn-authority"
import type { SessionPageConformanceUser } from "./session-page.conformance"

export type LatestViewConformanceHarness = {
  authority: PrivateSessionAuthority & SessionTurnAuthority
  workspaceId: string
  creator: SessionPageConformanceUser
}

type Page = { messages: Array<{ info: { id: string }; parts: Array<{ type: string }> }>; nextCursor?: string }

const transcriptEntry = (id: string, role: "user" | "assistant", parts: Array<Record<string, unknown>>) => ({ info: { id, role }, parts })

/**
 * A registry's answer to the semantic views over the transcript it stores:
 * the surface is the latest turn's prompt and answer, text only, and its
 * cursor pages back to everything the surface left out; the latest turn is
 * that turn whole. A session with no transcript answers none.
 */
export async function exerciseLatestViewConformance(harness: LatestViewConformanceHarness) {
  const { authority, workspaceId, creator } = harness
  const sessionId = "ses_latest_view"
  await authority.reserveSession(creator.auth, { operationId: "op_latest_view", sessionId, workspaceId, kind: "create" })
  await authority.registerRuntimeSession({ ...creator.runtime, operationId: "op_latest_view", sessionId, workspaceId })
  const read = async (input: { view?: "latest-turn" | "latest-surface"; limit?: number; before?: string }) =>
    await authority.readSessionMessages(creator.auth, { sessionId, workspaceId, ...input }) as Page
  const empty = await read({ view: "latest-surface" })
  latestViewHolds(empty.messages.length === 0 && !empty.nextCursor, "an empty transcript answered a surface")

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
      transcriptEntry("u1", "user", [{ type: "text", text: "first" }]),
      transcriptEntry("a1", "assistant", [{ type: "text", text: "first answer" }]),
      transcriptEntry("u2", "user", [{ type: "text", text: "second" }]),
      transcriptEntry("a2-tool", "assistant", [{ type: "tool", tool: "read" }]),
      transcriptEntry("a2", "assistant", [{ type: "reasoning", text: "thinking" }, { type: "text", text: "second answer" }]),
    ],
  })

  const surface = await read({ view: "latest-surface" })
  latestViewHolds(JSON.stringify(surface.messages.map((item) => item.info.id)) === '["u2","a2"]', "the surface is not the latest prompt and its final answer")
  latestViewHolds(surface.messages.every((item) => item.parts.every((part) => part.type === "text")), "the surface carried a part that is not text")
  latestViewHolds(!!surface.nextCursor, "the surface left messages out and named no cursor to them")
  const restored = await read({ limit: 50, before: surface.nextCursor })
  latestViewHolds(JSON.stringify(restored.messages.map((item) => item.info.id)) === '["u1","a1","u2","a2-tool"]', "paging back from the surface did not restore what it left out")

  const turn = await read({ view: "latest-turn" })
  latestViewHolds(JSON.stringify(turn.messages.map((item) => item.info.id)) === '["u2","a2-tool","a2"]', "the latest turn is not whole")
  return { surface: surface.messages.map((item) => item.info.id), turn: turn.messages.map((item) => item.info.id) }
}

function latestViewHolds(condition: unknown, text: string): asserts condition {
  if (!condition) throw new Error(`Latest-view conformance failed: ${text}`)
}
