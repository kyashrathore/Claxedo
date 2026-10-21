import type { AgentPluginExecutionSelection } from "@claxedo/server-core/agent-plugins/runtime/execution-selection"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { chooseProjectWorkspace } from "@claxedo/server-core/plugin-platform/sessions/project-workspace"
import type { CloudRoot, CloudTargetChoice, SessionHost, SessionRuntimeTarget } from "@claxedo/server-core/plugin-platform/sessions/session-bridge-core"
import type { SessionStartBlocker } from "@claxedo/server-core/plugin-platform/sessions/session-start"
import { createWorkspaceRuntimeClient, type WorkspaceRuntimeClientOptions } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { SessionHostReads } from "./reads"
import { createSessionRelease, createSessionReserve, type SessionReserveInput } from "./reservation"

/** A person a session is started for without a signed request behind it, by canonical actor in their organization. */
export type SessionOwner = Readonly<{ userId: string; actorId: string; orgId: string }>

/**
 * Who a cloud root is created as: the signed caller, or a person the host
 * resolved without a signed bearer to create with, whom it creates as by
 * canonical actor.
 */
export type CloudRootCreator =
  | Readonly<{ kind: "signed"; auth: SignedControlPlaneAuth }>
  | Readonly<{ kind: "owner"; owner: SessionOwner }>

/**
 * One root as the host files it. The origin key names the workspace, so the
 * workspace belongs to the same root as the session id and the reservation
 * derived from it, and a retry of that origin recovers all three.
 */
export type CloudRootRequest = Readonly<{ originKey: string; projectId: string; orgId: string; displayName: string }>

export type CloudRootAllocation = { workspace: Workspace } | { preparing: { workspaceId: string } } | { blocker: SessionStartBlocker }

/** The host's isolated workspaces, one per origin, created, admitted and started the way its create route does. */
export type CloudRoots = Readonly<{
  /** Why the host would refuse this root, read without filing a row or starting anything. */
  refusal(root: CloudRootRequest): Promise<SessionStartBlocker | undefined>
  /**
   * The root's workspace once its sandbox serves, or that its start is under
   * way, so a start never waits on a sandbox's boot. A creator nobody resolved
   * is refused by the host before anything is filed.
   */
  allocate(root: CloudRootRequest, creator: CloudRootCreator | undefined, capabilities: AgentPluginExecutionSelection): Promise<CloudRootAllocation>
}>

export type HostedSessionHostInput<Actor> = SessionReserveInput<Actor> & {
  /** The dispatch options a start reaches a workspace's runtime through, as the control plane's service actor. */
  runtimeClient: WorkspaceRuntimeClientOptions
  /**
   * The workspace and session rows the deployment's authorities write. The
   * sessions this host creates are recorded there by the runtime's own
   * registration, so the host only reads them.
   */
  reads: SessionHostReads
  cloudRoots: CloudRoots
  /**
   * The signed request an actor was minted from.
   *
   * A cloud root is a workspace this control plane creates mid-start, and the
   * workspace authority records a creator and an organization from the signed
   * caller. Created as anything else it is a workspace the caller cannot open
   * and a session reservation the authority refuses, because the reservation
   * selects the workspace row as the caller's own actor.
   */
  auth?: (actor: Actor) => SignedControlPlaneAuth | undefined
  /**
   * The person an actor with no signed request behind it acts for: a
   * session's agent starting through the grant its root was launched with, or
   * an app plugin's caller. Its root is created as that person's canonical
   * actor through the authority's runtime-principal path, so they can open it
   * and the reservation that follows, made as the same actor, is admitted. An
   * actor that neither resolver names is refused before anything is
   * allocated.
   */
  owner?: (actor: Actor) => SessionOwner | undefined
}

/** The hosted control plane's session ports: its D1 rows, its runtime dispatch, its reservations and its cloud roots. */
export function createHostedSessionHost<Actor>(input: HostedSessionHostInput<Actor>): SessionHost<Actor> {
  return {
    async target(workspaceId, starter) {
      const workspace = await input.reads.workspace(workspaceId)
      return workspace ? dispatchTarget(workspace, startingAs(input, starter)) : null
    },

    async projectTarget(projectId, starter) {
      const userId = starterUserId(input, starter)
      const chosen = chooseProjectWorkspace(projectId, userId ? await input.reads.projectWorkspaces(projectId, userId) : [])
      if (!("workspace" in chosen)) return chosen
      const target = dispatchTarget(chosen.workspace, startingAs(input, starter))
      return target ? { target } : { detail: "The project's workspace cannot be reached from here" }
    },

    ...hostedCloudRoots(input),

    sessionMetas: (sessionIds) => input.reads.sessions(sessionIds),

    registeredSessions: (sessionIds) => input.reads.sessions(sessionIds),

    reserve: createSessionReserve(input),

    release: createSessionRelease(input),
  }
}

/** The isolated workspace one origin runs in, created against the origin's project as the person the actor was minted from. */
function hostedCloudRoots<Actor>(input: HostedSessionHostInput<Actor>): Required<Pick<SessionHost<Actor>, "cloudTarget" | "cloudRefusal">> {
  const rootOf = (root: CloudRoot<Actor>): CloudRootRequest => ({ originKey: root.origin.key, projectId: root.projectId, orgId: root.orgId, displayName: root.displayName })
  return {
    cloudRefusal: (root) => input.cloudRoots.refusal(rootOf(root)),
    cloudTarget: async (root): Promise<CloudTargetChoice> => {
      const allocated = await input.cloudRoots.allocate(rootOf(root), rootCreator(input, root.actor), root.capabilities)
      if (!("workspace" in allocated)) return allocated
      // The start just proved this root's runtime answers; a client that
      // re-ensured the sandbox would run the driver a second time (1.2 s on
      // Cloudflare) and write the lease again before the first request.
      const target = dispatchTarget(allocated.workspace, { ...startingAs(input, root.actor), resume: false })
      return target ? { target } : { blocker: { code: "source_unavailable", detail: "The session's cloud workspace cannot be reached from here" } }
    },
  }
}

/** A signed caller creates as themselves; any other actor creates as the person the host resolved it to. */
function rootCreator<Actor>(input: HostedSessionHostInput<Actor>, actor: Actor): CloudRootCreator | undefined {
  const auth = input.auth?.(actor)
  if (auth) return { kind: "signed", auth }
  const owner = input.owner?.(actor)
  return owner ? { kind: "owner", owner } : undefined
}

/**
 * The runtime client a start dispatches through, as the person it starts for,
 * so a session it creates is theirs and spends their accounts.
 *
 * A signed caller is dispatched as their own canonical actor, with their
 * request behind the token: the runtime registers the session it creates as
 * the token's actor, and the reservation was made as that person, so a token
 * naming anyone else is a registration the authority refuses. A person
 * resolved without a signed request has no request to mint a token under;
 * that start dispatches as the control plane's service actor carrying the
 * person's user, through the door that admits a workspace's owner alone.
 */
function startingAs<Actor>(input: HostedSessionHostInput<Actor>, starter: Actor | null): WorkspaceRuntimeClientOptions {
  if (starter === null) return input.runtimeClient
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

function starterUserId<Actor>(input: HostedSessionHostInput<Actor>, starter: Actor): string | undefined {
  return input.auth?.(starter)?.principal?.userId ?? input.owner?.(starter)?.userId
}

function dispatchTarget(workspace: Workspace, options: WorkspaceRuntimeClientOptions): SessionRuntimeTarget | null {
  try {
    const client = createWorkspaceRuntimeClient({ workspace, options })
    return { workspace, request: (path, init) => client.request(path, init) }
  } catch {
    // A workspace this composition cannot dispatch to — no sandbox manager, no
    // relay, no local runtime in a Worker — is unreachable, not a fault.
    return null
  }
}
