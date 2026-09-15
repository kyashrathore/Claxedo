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
import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { TasksCapabilityOwner } from "@claxedo/server-core/tasks-host/capability"
import {
  startOriginId,
  type StartBlocker,
  type TasksActor,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"
import { allocateOriginCloudWorkspace } from "../workspace/origin-cloud-workspace"
import type { TasksRootIdentity } from "./root-capability"
import { configuredRelayUrl, type WorkspaceRuntimePreparation } from "../workspace/route-support"
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
   * The workspace owner a Tasks actor's grant resolved to, for an actor with
   * no signed request behind it: a session's agent starting a task through
   * the grant its root was launched with. The root is created as that
   * owner's canonical actor through the authority's runtime-principal path,
   * so the owner can open it and the reservation that follows, made as the
   * same actor, is admitted. An actor that neither resolver names is refused
   * before anything is allocated.
   */
  owner?: (actor: TasksActor) => TasksCapabilityOwner | undefined
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
  /** The withdrawal the workspace routes run on deletion; a discarded root is deleted here, so it runs here too. */
  releaseRuntime?: (context: { workspaceId: string }) => Promise<void>
  /**
   * The rest of what a cloud root's egress allowlist is built from: the
   * origin the runtime reports back to this control plane at, and the
   * operator's extra hosts. The relay comes from the services, per region.
   */
  sandboxEgress: Readonly<{ controlPlaneOrigin: string | undefined; extraHosts?: readonly string[] }>
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
 * workspace is created against the task's own project as the person the
 * actor was minted from — the signed caller, or the owner a grant resolved
 * to — so the authority resolves the same organization it resolved to admit
 * the task.
 */
function createTasksCloudTarget(
  input: HostedTasksSessionBridgeInput,
): NonNullable<TasksSessionHost["cloudTarget"]> {
  return async (origin): Promise<TasksCloudTargetChoice> => {
    const port = input.selectedCapabilities
    const creator = rootCreator(input, origin)
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
        // this creator that owner. The application user id is the authority's
        // own name for them; the actor's `ownerId` is the token subject, which
        // no workspace row records.
        const owner = creator?.owner
        const env = owner
          ? await input.capability?.({ ...owner, projectId: origin.task.projectId, workspaceId: workspace.id })
          : undefined
        return { ...(preparation.secrets ? { secrets: preparation.secrets } : {}), ...(env ? { env } : {}) }
      },
      services: input.services,
      egress: {
        controlPlane: [
          configuredRelayUrl({
            ...(input.services.relay.relayUrl ? { relayUrl: input.services.relay.relayUrl } : {}),
            ...(input.services.relay.relayUrls ? { relayUrls: input.services.relay.relayUrls } : {}),
            ...(input.services.defaultHomeRegion ? { defaultHomeRegion: input.services.defaultHomeRegion } : {}),
          }),
          input.sandboxEgress.controlPlaneOrigin,
        ],
        ...(input.sandboxEgress.extraHosts ? { extraHosts: input.sandboxEgress.extraHosts } : {}),
      },
      originKey: startOriginId(origin.actor.scopeId, origin.task.id, origin.slot, origin.attempt),
      projectId: origin.task.projectId,
      displayName: `${origin.task.title} (${origin.slot}, attempt ${origin.attempt})`,
      admit: async (workspace) => {
        if (!creator) {
          throw new Error(
            "this host creates a cloud root as the person starting it, and this caller is neither signed nor a grant this host resolved to an owner",
          )
        }
        await creator.admit(requireAuthority(input.services), {
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
        if (!creator) return
        await creator.discard(requireAuthority(input.services), { workspaceId: workspace.id })
        await input.releaseRuntime?.({ workspaceId: workspace.id })
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

type RootWorkspaceArgs = {
  workspaceId: string
  projectId: string
  displayName: string
  repoUrl?: string
  repoName?: string
  gitBranch?: string
  homeRegion?: string
}

/**
 * Who a cloud root is created as, and through which authority door.
 *
 * `owner` is what the root's own grant is minted for: absent for a signed
 * principal the authority never resolved to an application user, and then
 * the root launches with no Tasks grant rather than one naming nobody.
 */
type RootCreator = {
  owner: { userId: string; orgId: string } | undefined
  admit(authority: WorkspaceAuthority, args: RootWorkspaceArgs): Promise<void>
  discard(authority: WorkspaceAuthority, args: { workspaceId: string }): Promise<void>
}

/**
 * A signed caller creates as themselves; a grant's actor creates as the owner
 * the grant resolved to, by canonical actor, because a grant carries no signed
 * bearer to create with and none is fabricated for it. The owner's
 * organization stands in for the actor's scope on that path — the two are
 * one value, and the owner is the authoritative one.
 */
function rootCreator(input: HostedTasksSessionBridgeInput, origin: TasksCloudOrigin): RootCreator | undefined {
  const auth = input.auth?.(origin.actor)
  if (auth) {
    const userId = auth.principal?.userId
    return {
      owner: userId ? { userId, orgId: origin.actor.scopeId } : undefined,
      admit: (authority, args) => authority.createCloudWorkspace(auth, args).then(() => undefined),
      discard: (authority, args) => authority.deleteWorkspace(auth, args).then(() => undefined),
    }
  }
  const owner = input.owner?.(origin.actor)
  if (!owner) return undefined
  const principal = { principalKind: "user", actorId: owner.actorId, actorKind: "human" } as const
  return {
    owner: { userId: owner.userId, orgId: owner.orgId },
    admit: async (authority, args) => {
      if (!authority.createRuntimeCloudWorkspace) {
        throw new Error("this control plane cannot create a cloud root for a session's grant")
      }
      await authority.createRuntimeCloudWorkspace(principal, { ...args, orgId: owner.orgId })
    },
    discard: async (authority, args) => {
      await authority.deleteRuntimeWorkspace?.(principal, args)
    },
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
