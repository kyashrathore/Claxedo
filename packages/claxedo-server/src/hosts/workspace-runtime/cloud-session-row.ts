import type { AgentSession } from "@claxedo/agent-runtime-contract"
import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"

/** A committed runtime row, projected into the hosted inventory's wire contract. */
export function cloudSessionRow(session: AgentSession, workspaceId: string): HostSessionRow | undefined {
  if (session.parentID || session.workspaceId !== workspaceId) return undefined
  const { time, attention } = session
  if (!time || time.updated === undefined || !attention) throw new Error(`Session ${session.id} lacks committed inventory facts`)
  const status = session.status === "error" ? "interrupted" : session.status
  if (status !== "idle" && status !== "busy" && status !== "retry" && status !== "interrupted") {
    throw new Error(`Session ${session.id} has no canonical runtime status`)
  }
  return {
    workspaceId,
    sessionId: session.id,
    ...(session.title ? { title: session.title } : {}),
    createdAt: time.created,
    updatedAt: time.updated,
    ...(time.lastHumanTurn === undefined ? {} : { lastHumanTurnAt: time.lastHumanTurn }),
    ...(time.archived === undefined ? {} : { archivedAt: time.archived }),
    attention,
    ...(session.lastTurn ? { lastTurn: session.lastTurn } : {}),
    status: {
      kind: status,
      awaitingInput: attention.awaitingInput,
      ...(session.backgroundWork ? { backgroundWork: session.backgroundWork } : {}),
      at: time.updated,
    },
  }
}
