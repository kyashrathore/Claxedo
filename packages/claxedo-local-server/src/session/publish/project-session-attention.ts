import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { embeddedWorkspaceRuntimeGeneration, readMountedEmbeddedWorkspaceRuntime } from "../../deployments/local/embedded-workspace-runtime"

export async function projectSessionAttention(store: Pick<SessionProjectionStore, "sync_session_meta">, workspaceId: string, sessionId: string) {
  const workspace = await resolveWorkspace({ workspaceId })
  if (!workspace) throw new Error(`Workspace ${workspaceId} is unavailable`)
  const generation = embeddedWorkspaceRuntimeGeneration(workspaceId)
  if (generation === undefined) throw new Error(`Runtime ${workspaceId} is unavailable`)
  const response = await readMountedEmbeddedWorkspaceRuntime(workspaceId, `/session/${encodeURIComponent(sessionId)}`)
  if (!response) throw new Error(`Runtime ${workspaceId} is unavailable`)
  if (embeddedWorkspaceRuntimeGeneration(workspaceId) !== generation) throw new Error(`Runtime ${workspaceId} changed during session read`)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`Runtime session read failed: ${response.status}`)
  const session = await response.json()
  if (embeddedWorkspaceRuntimeGeneration(workspaceId) !== generation) throw new Error(`Runtime ${workspaceId} changed during session read`)
  await store.sync_session_meta(workspace, session)
  return true
}
