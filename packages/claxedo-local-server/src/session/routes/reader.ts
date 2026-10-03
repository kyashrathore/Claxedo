import { HTTPException } from "hono/http-exception"
import type { SessionReaderCommand } from "@claxedo/agent-runtime-contract"
import { sessionMetaInWorkspace, syncSessionMeta } from "@claxedo/server-core/session/meta/index"
import { LOCAL_SESSION_READER, writeSessionReader } from "@claxedo/server-core/session/reader"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { controlBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import { embeddedWorkspaceRuntimeGeneration, readMountedEmbeddedWorkspaceRuntime } from "../../deployments/local/embedded-workspace-runtime"

export async function writeLocalSessionReader(sessionId: string, workspaceId: string, command: SessionReaderCommand) {
  const meta = await sessionMetaInWorkspace(sessionId, workspaceId)
  if (!meta?.workspaceID) throw new HTTPException(404, { message: "Session not found" })
  const workspace = await resolveWorkspace({ workspaceId: meta.workspaceID })
  if (!workspace) throw new HTTPException(503, { message: "Session workspace is unavailable" })
  let runtimeGeneration: string | undefined
  if (command.kind === "settle") {
    runtimeGeneration = embeddedWorkspaceRuntimeGeneration(workspaceId)
    if (runtimeGeneration === undefined) throw new HTTPException(503, { message: "Session runtime is unavailable" })
    const response = await readMountedEmbeddedWorkspaceRuntime(meta.workspaceID, `/session/${encodeURIComponent(sessionId)}`)
    if (!response) throw new HTTPException(503, { message: "Session runtime is unavailable" })
    if (!response.ok) throw new HTTPException(response.status === 404 ? 404 : 503, { message: "Session runtime read failed" })
    await syncSessionMeta(workspace, await response.json())
  }
  const current = await sessionMetaInWorkspace(sessionId, workspaceId)
  if (!current?.attention || !current.sessionRef || !current.projectID) throw new HTTPException(503, { message: "Session activity is unavailable" })
  // No await follows this admission: the synchronous reader transaction sees the same serving mount.
  if (command.kind === "settle" && embeddedWorkspaceRuntimeGeneration(workspaceId) !== runtimeGeneration) throw new HTTPException(503, { message: "Session runtime changed" })
  const result = writeSessionReader({ sessionRef: current.sessionRef, readerId: LOCAL_SESSION_READER, command, now: Date.now() })
  if (result.ok) controlBus.publish({ type: "session.reader.changed", workspaceId: meta.workspaceID,
    sessionId, projectId: current.projectID, ...(workspace.org_id ? { orgId: workspace.org_id } : {}), reader: result.state, ts: Date.now() })
  return result
}
