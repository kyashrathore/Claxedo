import type { WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import type { SessionCleanupPosition, SessionCleanupTarget } from "@claxedo/agent-runtime-contract"
import type { SessionNavigationRow } from "./navigation-list"

export async function prepareRuntimeSessionCleanup(server: WorkspaceRuntimeClient, row: SessionNavigationRow) {
  const root = (await server.session.get({ sessionID: row.sessionId })).data
  if (!root.attention || !row.attention) return { unavailable: "Authoritative session facts are unavailable" }
  if (root.attention.generation !== row.attention.generation || root.attention.activitySequence !== row.attention.activitySequence) {
    return { unavailable: "The session changed since the inventory snapshot; retry after reconciliation" }
  }
  const children = (await server.session.children({ sessionID: row.sessionId })).data
  const descendants: SessionCleanupPosition[] = []
  for (const child of children) {
    if (!child.attention) return { unavailable: `Child session ${child.id} has no authoritative activity facts` }
    descendants.push({ sessionId: child.id, generation: child.attention.generation, activitySequence: child.attention.activitySequence })
  }
  return { descendants }
}

export async function deleteRuntimeSessionCleanup(server: WorkspaceRuntimeClient, target: SessionCleanupTarget) {
  const response = await server.session.delete({
    sessionID: target.sessionId,
    expected: { generation: target.generation, activitySequence: target.activitySequence },
    descendants: [...target.descendants],
  })
  if (!response.data.deletedSessionIds) throw new Error("Runtime delete returned no deletion receipt")
  return { deletedSessionIds: response.data.deletedSessionIds }
}
