import { chooseProjectWorkspace } from "@claxedo/server-core/tasks-host/project-workspace"
import {
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
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { TasksCapabilityOwner } from "@claxedo/server-core/tasks-host/capability"
import {
  startOriginId,
  type StartBlocker,
  type TasksActor,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"
import {
  createCloudCreateAdmission,
  type CloudCreateAdmission,
  type CloudCreateCaller,
  type CloudCreateUsage,
} from "../workspace/cloud-create-admission"
import { startCloudWorkspace } from "../workspace/cloud-workspace-start"
import {
  allocateOriginCloudWorkspace,
  originCloudRoot,
  originCloudWorkspaceId,
  type OriginCloudRootInput,
} from "../workspace/origin-cloud-workspace"
import type { SandboxStart } from "../workspace/sandbox-start"
import type { TasksHostReads } from "./d1-host-reads"
import { createTasksSessionRelease, createTasksSessionReserve, type TasksSessionReserveInput } from "./session-reservation"

export type HostedTasksSessionBridgeInput = TasksSessionReserveInput & {
  runtimeClient: WorkspaceRuntimeClientOptions
  /**
   * The workspace and session rows the deployment's authorities write. The
   * sessions this bridge creates are recorded there by the runtime's own
   * registration, so the bridge only reads them.
   */
  reads: TasksHostReads
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
   * The workspace's one sandbox start, the same one a person's connect begins:
   * it takes the lease, announces the start to the owner's open clients and
   * drives the sandbox to ready in the background, preparing every step with
   * the capability set the start names (the owner's accounts, the project's
   * environment, the root's Tasks grant and its selected plugins and skills).
   * A deployment that names none cannot start a cloud root, and a cloud Start
   * is refused before anything is filed.
   */
  sandboxStart?: SandboxStart
  /**
   * The admission a cloud root's create passes through — the same gates `POST
   * /api/workspace/create` applies, keyed on whoever the root is created as.
   * A bridge built without one still runs the authority's own create
   * admission and a per-bridge create budget; the product gates — entitlement,
   * a create bucket shared with the route, the lease cap's counter — arrive
   * only through the deployment's composition.
   */
  cloudCreateAdmission?: CloudCreateAdmission
  /**
   * The usage side effects a workspace's first explicit start runs on the
   * lease it opens, fired identically for a task-driven root: the event that makes the
   * spend attributable and the tenant stamp the concurrency cap counts.
   * Absent, a root's lease is created but unattributed, which is exactly what
   * leaves it invisible to the cap.
   */
  sandboxUsage?: CloudCreateUsage
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
 * The isolated workspace one Tasks root runs in.
 *
 * The origin key is the kit's own `(scope, task, slot, attempt)` string, so
 * the workspace belongs to the same root as the session id and the reservation
 * derived from it, and a retry of that attempt recovers all three. The
 * workspace is created against the task's own project as the person the
 * actor was minted from — the signed caller, or the owner a grant resolved
 * to — so the authority resolves the same organization it resolved to admit
 * the task. A root whose start is still under way answers `preparing`, so a
 * Start never waits on a sandbox's boot.
 */
function createTasksCloudRoots(
  input: HostedTasksSessionBridgeInput,
): Required<Pick<TasksSessionHost, "cloudTarget" | "cloudRefusal">> {
  // A bridge composed without one still answers its authority half: the
  // authority's own create admission and a create budget that lives as long
  // as this bridge.
  const admission = input.cloudCreateAdmission ?? createCloudCreateAdmission({ services: input.services })
  const rootOf = (origin: TasksCloudOrigin): OriginCloudRootInput => ({
    services: input.services,
    rows: input.reads,
    originKey: startOriginId(origin.actor.scopeId, origin.task.id, origin.slot, origin.attempt),
    projectId: origin.task.projectId,
    orgId: origin.actor.scopeId,
    displayName: `${origin.task.title} (${origin.slot}, attempt ${origin.attempt})`,
  })
  const unstartable: StartBlocker = { code: "placement_unsupported", detail: "This control plane cannot start a cloud root" }
  return {
    cloudRefusal: async (origin) => {
      const root = await originCloudRoot(rootOf(origin))
      if (!("id" in root)) return { code: root.code, detail: root.detail }
      return input.sandboxStart ? undefined : unstartable
    },
    cloudTarget: async (origin): Promise<TasksCloudTargetChoice> => {
      const start = input.sandboxStart
      const sandboxManager = input.services.sandbox.sandboxManager
      if (!start || !sandboxManager) return { blocker: unstartable }
      const creator = rootCreator(input, origin)
      // The create route's own admission, before a row or a sandbox exists: the
      // create budget, the authority's create admission, the deployment's
      // cloud-workspace admission, and the concurrent-lease cap. A caller nobody resolved keeps
      // its refusal inside `admit` below, where it always was. `existing` marks
      // the retry of a root that already holds its lease: that lease is the
      // cap's own, so the cap does not count it a second time. A root with no
      // row yet has no lease, and a deployment's manager cannot place a
      // workspace its authority has never heard of to look one up.
      if (creator) {
        const rootId = await originCloudWorkspaceId(rootOf(origin).originKey)
        const lease = await input.reads.workspace(rootId) ? await sandboxManager.target(rootId) : undefined
        const existing = lease !== undefined && !(lease.status === "unavailable" && lease.reason === "runtime_lease_missing")
        const admitted =
          await admission.preflight(creator.caller) ??
          await admission.admit(creator.caller, { projectId: origin.task.projectId }, { existing })
        if ("status" in admitted) {
          return { blocker: { code: "source_unavailable", detail: admitted.body.error.message } }
        }
      }
      const allocated = await allocateOriginCloudWorkspace({
        ...rootOf(origin),
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
            ...(workspace.remote_directory ? { remoteDirectory: workspace.remote_directory } : {}),
            ...(input.services.defaultHomeRegion ? { homeRegion: input.services.defaultHomeRegion } : {}),
          })
        },
        // A Start asks for this root anew, so a failure held from its last
        // start does not answer it.
        start: async (workspace) => {
          if (!creator) throw new Error("a cloud root is started only after its creator filed it")
          return startCloudWorkspace(input.services, start, { admission, usage: input.sandboxUsage }, creator.caller, {
            workspaceId: workspace.id,
            orgId: origin.actor.scopeId,
            ...(input.services.defaultHomeRegion ? { homeRegion: input.services.defaultHomeRegion } : {}),
            current: await sandboxManager.target(workspace.id),
            request: { retry: true, capabilities: origin.capabilities },
          })
        },
      })
      if ("code" in allocated) return { blocker: { code: allocated.code, detail: allocated.detail } }
      if (allocated.state === "starting") return { preparing: { workspaceId: allocated.workspace.id } }
      const target = dispatchTarget(allocated.workspace, startingAs(input, origin.actor))
      return target ? { target } : {
        blocker: {
          code: "source_unavailable",
          detail: "The task's cloud workspace cannot be reached from here",
        },
      }
    },
  }
}

type RootWorkspaceArgs = {
  workspaceId: string
  projectId: string
  displayName: string
  repoUrl?: string
  repoName?: string
  gitBranch?: string
  remoteDirectory?: string
  homeRegion?: string
}

/**
 * Who a cloud root is created as, and through which authority door.
 *
 * `caller` is the identity create admission runs against — the signed request
 * or the resolved owner. `owner` is what the root's own grant is minted for:
 * absent for a signed principal the authority never resolved to an
 * application user, and then the root launches with no Tasks grant rather
 * than one naming nobody.
 */
type RootCreator = {
  caller: CloudCreateCaller
  owner: { userId: string; orgId: string } | undefined
  admit(authority: WorkspaceAuthority, args: RootWorkspaceArgs): Promise<void>
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
      caller: { kind: "signed", auth },
      owner: userId ? { userId, orgId: origin.actor.scopeId } : undefined,
      admit: (authority, args) => authority.createCloudWorkspace(auth, args).then(() => undefined),
    }
  }
  const owner = input.owner?.(origin.actor)
  if (!owner) return undefined
  const principal = { principalKind: "user", actorId: owner.actorId, actorKind: "human" } as const
  return {
    caller: { kind: "owner", owner: { userId: owner.userId, orgId: owner.orgId } },
    owner: { userId: owner.userId, orgId: owner.orgId },
    admit: async (authority, args) => {
      if (!authority.createRuntimeCloudWorkspace) {
        throw new Error("this control plane cannot create a cloud root for a session's grant")
      }
      await authority.createRuntimeCloudWorkspace(principal, { ...args, orgId: owner.orgId })
    },
  }
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
