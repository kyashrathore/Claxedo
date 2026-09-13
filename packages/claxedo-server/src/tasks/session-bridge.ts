import {
  chooseProjectWorkspace,
  createTasksSessionBridge,
  type TasksCloudOrigin,
  type TasksCloudTargetChoice,
  type TasksRuntimeTarget,
  type TasksSessionHost,
} from "@claxedo/server-core/tasks-host/session-bridge-core"
import {
  createWorkspaceRuntimeClient,
  type WorkspaceRuntimeClientOptions,
} from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { listWorkspaces, resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  startOriginId,
  type StartBlocker,
  type TasksActor,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"
import { allocateOriginCloudWorkspace } from "../workspace/origin-cloud-workspace"
import type { TasksRootIdentity } from "./root-capability"
import type { WorkspaceRuntimePreparation } from "../workspace/route-support"
import { createTasksSessionRelease, createTasksSessionReserve, type TasksSessionReserveInput } from "./session-reservation"

export type HostedTasksSessionBridgeInput = TasksSessionReserveInput & {
  runtimeClient: WorkspaceRuntimeClientOptions
  /**
   * The signed request a Tasks actor was minted from.
   *
   * A cloud root is a workspace this control plane creates mid-Start, and the
   * workspace authority records a creator and an organization from the signed
   * caller. Created as anything else it is a workspace the caller cannot open
   * and a session reservation the authority refuses, because the reservation
   * selects the workspace row as the caller's own actor.
   */
  auth?: (actor: TasksActor) => SignedControlPlaneAuth | undefined
  /**
   * Projects a cloud root's capability set onto the workspace it will run in,
   * and resolves only once the runtime has acknowledged that exact selection.
   *
   * A deployment that cannot do it names nothing here and its cloud Starts are
   * blocked: a root started without the projection would run on whatever the
   * project's defaults put in that sandbox, which is the one outcome the
   * selection exists to prevent.
   */
  selectedCapabilities?: {
    /**
     * Resolves the selection and the credentials its servers need. Runs before
     * the sandbox exists, because a brokered credential reaches a runtime only
     * through the create that carries it.
     */
    prepare(input: {
      workspaceId: string
      capabilities: TasksCloudOrigin["capabilities"]
    }): Promise<WorkspaceRuntimePreparation>
    /** Projects it, and resolves only once the runtime acknowledged that exact selection. */
    apply(input: { workspaceId: string; preparation: WorkspaceRuntimePreparation }): Promise<void>
  }
  /**
   * The Tasks grant this root's sessions act with, minted beside the cloud
   * root's other credentials and handed to its runtime as environment. A
   * deployment that names none launches roots whose agents have no Tasks
   * tools, which is what a control plane those sessions cannot reach means.
   */
  capability?: (root: TasksRootIdentity) => Promise<Record<string, string>>
}

export function createHostedTasksSessionBridge(input: HostedTasksSessionBridgeInput): TasksSessionBridgePort {
  return createTasksSessionBridge({
    async target(workspaceId) {
      const workspace = await resolveWorkspace({ workspaceId }).catch(() => undefined)
      return workspace ? dispatchTarget(workspace, input.runtimeClient) : null
    },

    async projectTarget(projectId) {
      const chosen = chooseProjectWorkspace(projectId, await listWorkspaces().catch(() => []))
      if (!("workspace" in chosen)) return chosen
      const target = dispatchTarget(chosen.workspace, input.runtimeClient)
      return target ? { target } : {
        detail: `Workspace ${chosen.workspace.id} is not reachable from this control plane`,
      }
    },

    cloudTarget: createTasksCloudTarget(input),

    sessionMetas: (sessionIds) => input.services.projectionStore.session_metas([...sessionIds]),

    reserve: createTasksSessionReserve(input),

    release: createTasksSessionRelease(input),

    projectSessionMeta: (created) => input.services.projectionStore.put_session_meta(created.sessionId, {
      ws: created.target.workspace,
      host: "workspace",
      workspaceID: created.target.workspace.id,
      title: created.title,
      model: created.model,
    }),

    forgetSessionMeta: (sessionId) => input.services.projectionStore.delete_session_meta(sessionId),
  })
}

/**
 * The isolated workspace one Tasks root runs in.
 *
 * The origin key is the kit's own `(scope, task, slot, attempt)` string, so
 * the workspace belongs to the same root as the session id and the reservation
 * derived from it, and a retry of that attempt recovers all three. The
 * workspace is created as the signed caller against the task's own project, so
 * the authority resolves the same organization it resolved to admit the task.
 */
function createTasksCloudTarget(
  input: HostedTasksSessionBridgeInput,
): NonNullable<TasksSessionHost["cloudTarget"]> {
  return async (origin): Promise<TasksCloudTargetChoice> => {
    const port = input.selectedCapabilities
    const auth = input.auth?.(origin.actor)
    let projected: (() => Promise<void>) | undefined
    // Resolving the capability set inside the allocation is what orders these
    // two refusals: a deployment with no driver never reaches it and says so,
    // and one that has a driver but cannot project a selection stops before a
    // sandbox exists rather than after paying for one.
    const allocate = () => allocateOriginCloudWorkspace({
      prepare: async (workspace) => {
        if (!port) {
          throw new Error("this control plane cannot project a selected capability set into a cloud root")
        }
        const preparation = await port.prepare({ workspaceId: workspace.id, capabilities: origin.capabilities })
        projected = () => port.apply({ workspaceId: workspace.id, preparation })
        // The capability names the workspace's owner, and `admit` below makes
        // this caller that owner. The application user id is the authority's
        // own name for them; the actor's `ownerId` is the token subject, which
        // no workspace row records.
        const owner = auth?.principal?.userId
        const env = owner
          ? await input.capability?.({
              userId: owner,
              orgId: origin.actor.scopeId,
              projectId: origin.task.projectId,
              workspaceId: workspace.id,
            })
          : undefined
        return { ...(preparation.secrets ? { secrets: preparation.secrets } : {}), ...(env ? { env } : {}) }
      },
      services: input.services,
      originKey: startOriginId(origin.actor.scopeId, origin.task.id, origin.slot, origin.attempt),
      projectId: origin.task.projectId,
      displayName: `${origin.task.title} (${origin.slot}, attempt ${origin.attempt})`,
      admit: async (workspace) => {
        if (!auth) {
          throw new Error("this host creates a cloud root as the person starting it, and this caller is not signed")
        }
        await requireAuthority(input.services).createCloudWorkspace(auth, {
          workspaceId: workspace.id,
          projectId: origin.task.projectId,
          displayName: workspace.workspace_name ?? workspace.id,
          ...(workspace.repo_url ? { repoUrl: workspace.repo_url } : {}),
          ...(workspace.repo_name ? { repoName: workspace.repo_name } : {}),
          ...(workspace.git_branch ? { gitBranch: workspace.git_branch } : {}),
          ...(input.services.defaultHomeRegion ? { homeRegion: input.services.defaultHomeRegion } : {}),
        })
      },
      discard: async (workspace) => {
        if (!auth) return
        await requireAuthority(input.services).deleteWorkspace(auth, { workspaceId: workspace.id })
      },
    })
    let allocated
    try {
      allocated = await allocate()
    } catch (error) {
      return { blocker: capabilityBlocker(origin, error) }
    }
    if ("code" in allocated) return { blocker: { code: allocated.code, detail: allocated.detail } }
    try {
      if (!projected) throw new Error("the capability set for this root was never resolved")
      await projected()
    } catch (error) {
      return { blocker: capabilityBlocker(origin, error) }
    }
    const target = dispatchTarget(allocated.workspace, input.runtimeClient)
    return target ? { target } : {
      blocker: {
        code: "source_unavailable",
        detail: `Cloud root ${allocated.workspace.id} is not reachable from this control plane`,
      },
    }
  }
}

function capabilityBlocker(origin: TasksCloudOrigin, error: unknown): StartBlocker {
  return {
    code: "capability_unavailable",
    detail: `The capability set for ${origin.task.id} (${origin.slot}, attempt ${origin.attempt}) could not be applied: ${error instanceof Error ? error.message : String(error)}`,
  }
}

function dispatchTarget(workspace: Workspace, options: WorkspaceRuntimeClientOptions): TasksRuntimeTarget | null {
  try {
    const client = createWorkspaceRuntimeClient({ workspace, options })
    return { workspace, request: (path, init) => client.request(path, init) }
  } catch {
    // A workspace this composition cannot dispatch to — no sandbox manager, no
    // relay, no local runtime in a Worker — is unreachable, not a fault.
    return null
  }
}
