import { putSessionMeta, sessionMetas } from "@claxedo/server-core/session/meta/index"
import {
  chooseProjectWorkspace,
  createTasksSessionBridge,
  type TasksRuntimeTarget,
} from "@claxedo/server-core/tasks-host/session-bridge-core"
import { createWorkspaceRuntimeClient } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { listWorkspaces, resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import type { TasksSessionBridgePort } from "@claxedo/tasks"

/**
 * Tasks' half of Start on a local host: the embedded workspace runtime this
 * process serves, and the session projection it lists sessions from.
 */
export function createLocalTasksSessionBridge(): TasksSessionBridgePort {
  return createTasksSessionBridge({
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
  })
}

function embeddedTarget(workspace: Workspace): TasksRuntimeTarget {
  const client = createWorkspaceRuntimeClient({ workspace, directory: workspace.directory })
  return { workspace, request: (path, init) => client.request(path, init) }
}
