import { deleteSessionMeta, putSessionMeta, sessionMetas } from "@claxedo/server-core/session/meta/index"
import {
  chooseProjectWorkspace,
  createTasksSessionBridge,
  type TasksRuntimeTarget,
  type TasksSessionHost,
} from "@claxedo/server-core/tasks-host/session-bridge-core"
import { createWorkspaceRuntimeClient } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { listWorkspaces, resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import type { TasksSessionBridgePort } from "@claxedo/tasks"

export type LocalTasksSessionBridgeInput = {
  /**
   * Admission a signed self-host requires before a create. Its sessions are
   * granted to a creator actor, so a session reserved for nobody is one the
   * member who pressed Start cannot open. The unsigned single-user posture has
   * no actors to record and supplies none.
   */
  reserve?: TasksSessionHost["reserve"]
  /** The undo of that admission, so a host that reserves can also give an origin back. */
  release?: TasksSessionHost["release"]
}

export function createLocalTasksSessionBridge(input: LocalTasksSessionBridgeInput = {}): TasksSessionBridgePort {
  return createTasksSessionBridge({
    ...(input.reserve ? { reserve: input.reserve } : {}),
    ...(input.release ? { release: input.release } : {}),

    async target(workspaceId) {
      const workspace = await resolveWorkspace({ workspaceId })
      return workspace && workspace.kind !== "cloud" ? embeddedTarget(workspace) : null
    },

    async projectTarget(projectId) {
      const local = (await listWorkspaces()).filter((workspace) => workspace.kind !== "cloud")
      const chosen = chooseProjectWorkspace(projectId, local)
      return "workspace" in chosen ? { target: embeddedTarget(chosen.workspace) } : chosen
    },

    sessionMetas: (sessionIds) => sessionMetas([...sessionIds]),

    // A Start reaches the runtime through the local runtime port, so the local
    // app's response tap never sees the create: without this the session is
    // missing from every list, including the liveness read above.
    projectSessionMeta: (input: { sessionId: string; target: TasksRuntimeTarget; title: string; model: { providerID: string; modelID: string } }) =>
      putSessionMeta(input.sessionId, {
        ws: input.target.workspace,
        host: "workspace",
        title: input.title,
        model: input.model,
      }),

    forgetSessionMeta: (sessionId) => deleteSessionMeta(sessionId),
  })
}

function embeddedTarget(workspace: Workspace): TasksRuntimeTarget {
  const client = createWorkspaceRuntimeClient({ workspace, directory: workspace.directory })
  return { workspace, request: (path, init) => client.request(path, init) }
}
