import { chooseProjectWorkspace } from "../host/project-workspace"
import {
  createTasksSessionBridge,
  type TasksCloudOrigin,
  type TasksCloudTargetChoice,
  type TasksRuntimeTarget,
  type TasksSessionHost,
} from "../host/session-bridge-core"
import {
  createWorkspaceRuntimeClient,
  type WorkspaceRuntimeClientOptions,
} from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { TasksCapabilityOwner } from "../host/capability"
import {
  startOriginId,
  type StartBlocker,
  type TasksActor,
  type TasksSessionBridgePort,
} from ".."
import type { TasksHostReads } from "./d1-host-reads"
import { createTasksSessionRelease, createTasksSessionReserve, type TasksSessionReserveInput } from "./session-reservation"

/**
 * Who a cloud root is created as: the signed caller, or the workspace owner a
 * grant resolved to, whom the host creates as by canonical actor because a
 * grant carries no signed bearer to create with.
 */
export type TasksCloudRootCreator =
  | Readonly<{ kind: "signed"; auth: SignedControlPlaneAuth }>
  | Readonly<{ kind: "owner"; owner: TasksCapabilityOwner }>

/**
 * One root as the host files it. The origin key is the kit's own `(scope,
 * task, slot, attempt)` string, so the workspace belongs to the same root as
 * the session id and the reservation derived from it, and a retry of that
 * attempt recovers all three.
 */
export type TasksCloudRootRequest = Readonly<{
  originKey: string
  projectId: string
  orgId: string
  displayName: string
}>

export type TasksCloudRootAllocation =
  | { workspace: Workspace }
  | { preparing: { workspaceId: string } }
  | { blocker: StartBlocker }

/** The host's isolated workspaces, one per Tasks root, created, admitted and started the way its create route does. */
export type TasksCloudRoots = Readonly<{
  /** Why the host would refuse this root, read without filing a row or starting anything. */
  refusal(root: TasksCloudRootRequest): Promise<StartBlocker | undefined>
  /**
   * The root's workspace once its sandbox serves, or that its start is under
   * way, so a Start never waits on a sandbox's boot. A creator nobody resolved
   * is refused by the host before anything is filed.
   */
  allocate(
    root: TasksCloudRootRequest,
    creator: TasksCloudRootCreator | undefined,
    capabilities: TasksCloudOrigin["capabilities"],
  ): Promise<TasksCloudRootAllocation>
}>

export type HostedTasksSessionBridgeInput = TasksSessionReserveInput & {
  runtimeClient: WorkspaceRuntimeClientOptions
  /**
   * The workspace and session rows the deployment's authorities write. The
   * sessions this bridge creates are recorded there by the runtime's own
   * registration, so the bridge only reads them.
   */
  reads: TasksHostReads
  cloudRoots: TasksCloudRoots
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
}

export function createHostedTasksSessionBridge(input: HostedTasksSessionBridgeInput): TasksSessionBridgePort {
  return createTasksSessionBridge({
    async target(workspaceId, starter) {
      const workspace = await input.reads.workspace(workspaceId)
      return workspace ? dispatchTarget(workspace, startingAs(input, starter)) : null
    },

    async projectTarget(projectId, starter) {
      const userId = starterUserId(input, starter)
      const chosen = chooseProjectWorkspace(projectId, userId ? await input.reads.projectWorkspaces(projectId, userId) : [])
      if (!("workspace" in chosen)) return chosen
      const target = dispatchTarget(chosen.workspace, startingAs(input, starter))
      return target ? { target } : {
        detail: "The task's workspace cannot be reached from here",
      }
    },

    ...createTasksCloudRoots(input),

    sessionMetas: (sessionIds) => input.reads.sessions(sessionIds),

    registeredSessions: (sessionIds) => input.reads.sessions(sessionIds),

    reserve: createTasksSessionReserve(input),

    release: createTasksSessionRelease(input),
  })
}

/**
 * The isolated workspace one Tasks root runs in, created against the task's
 * own project as the person the actor was minted from, so the authority
 * resolves the same organization it resolved to admit the task.
 */
function createTasksCloudRoots(
  input: HostedTasksSessionBridgeInput,
): Required<Pick<TasksSessionHost, "cloudTarget" | "cloudRefusal">> {
  const rootOf = (origin: TasksCloudOrigin): TasksCloudRootRequest => ({
    originKey: startOriginId(origin.actor.scopeId, origin.task.id, origin.slot, origin.attempt),
    projectId: origin.task.projectId,
    orgId: origin.actor.scopeId,
    displayName: `${origin.task.title} (${origin.slot}, attempt ${origin.attempt})`,
  })
  return {
    cloudRefusal: (origin) => input.cloudRoots.refusal(rootOf(origin)),
    cloudTarget: async (origin): Promise<TasksCloudTargetChoice> => {
      const allocated = await input.cloudRoots.allocate(rootOf(origin), rootCreator(input, origin.actor), origin.capabilities)
      if (!("workspace" in allocated)) return allocated
      // The start just proved this root's runtime answers; a client that
      // re-ensured the sandbox would run the driver a second time (1.2 s on
      // Cloudflare) and write the lease again before the first request.
      const target = dispatchTarget(allocated.workspace, { ...startingAs(input, origin.actor), resume: false })
      return target ? { target } : {
        blocker: {
          code: "source_unavailable",
          detail: "The task's cloud workspace cannot be reached from here",
        },
      }
    },
  }
}

/** A signed caller creates as themselves; a grant's actor creates as the owner the grant resolved to. */
function rootCreator(input: HostedTasksSessionBridgeInput, actor: TasksActor): TasksCloudRootCreator | undefined {
  const auth = input.auth?.(actor)
  if (auth) return { kind: "signed", auth }
  const owner = input.owner?.(actor)
  return owner ? { kind: "owner", owner } : undefined
}

/**
 * The runtime client a Start dispatches through, as the person it starts for,
 * so a session it creates is theirs and spends their accounts.
 *
 * A signed caller is dispatched as their own canonical actor, with their
 * request behind the token: the runtime registers the session it creates as
 * the token's actor, and the reservation was made as that person, so a token
 * naming anyone else is a registration the authority refuses. The owner a
 * grant resolved to has no signed request to mint a token under; that Start
 * dispatches as the control plane's service actor carrying the owner's user.
 */
function startingAs(input: HostedTasksSessionBridgeInput, starter: TasksActor | null): WorkspaceRuntimeClientOptions {
  if (!starter) return input.runtimeClient
  const auth = input.auth?.(starter)
  const person = auth?.principal
  if (auth && person?.actorKind === "human") {
    return {
      ...input.runtimeClient,
      auth,
      runtimeActor: { principalKind: "user", actorId: person.actorId, actorKind: "human", userId: person.userId },
    }
  }
  const owner = input.owner?.(starter)
  if (!owner) return input.runtimeClient
  return {
    ...input.runtimeClient,
    ownerGrant: true,
    runtimeActor: { principalKind: "user", actorId: owner.actorId, actorKind: "human", userId: owner.userId },
  }
}

function starterUserId(input: HostedTasksSessionBridgeInput, starter: TasksActor): string | undefined {
  return input.auth?.(starter)?.principal?.userId ?? input.owner?.(starter)?.userId
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
