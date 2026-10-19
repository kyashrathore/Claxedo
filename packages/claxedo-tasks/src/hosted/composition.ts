import type { D1Database } from "@cloudflare/workers-types"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SandboxPassRegister } from "@claxedo/server-core/platform/auth/sandbox-pass-register"
import type { SignedTasksAuthenticateInput, TasksRuntimePrincipal } from "../host/authorization"
import { signedTasksIdentity, tasksRouteContribution } from "../host/contribution"
import { createTasksCapabilities } from "../host/host-ports"
import type { TasksActor, TasksHostCapabilities, TasksSessionBridgePort } from ".."
import type { TasksCapabilityOwner, TasksCapabilityPort } from "../host/capability"
import { verifyTasksCapability } from "./capability"
import { createD1TasksStore } from "../storage/d1/d1-store"

export type HostedTasksComposition = {
  routeContributions: readonly ControlPlaneRouteContribution[]
}

export type HostedTasksCompositionInput = {
  /** The workspace authority every other hosted route asks. */
  authority: WorkspaceAuthority
  database: D1Database
  /** The deployment's signed-request reader, which answers a refusal in the deployment's own words. */
  signed: SignedTasksAuthenticateInput["signed"]
  /**
   * Built here rather than passed in, because the bridge has to reserve each
   * session — and create a cloud root's own workspace — as the person who
   * started it, and only this composition holds the registry that maps a Tasks
   * actor back to that person: the signed request it was minted from, or the
   * workspace owner its grant resolved to.
   */
  bridge: (principal: TasksRuntimePrincipal, auth: TasksSignedAuth, owner: TasksGrantOwner) => TasksSessionBridgePort
  /**
   * Whether this deployment has an isolated root to allocate at all: the same
   * reading the workspace routes make before they will create a cloud
   * workspace.
   */
  cloudPlacement: boolean
  /**
   * Whether this deployment can project a cloud root's selected capability
   * set. It is the build's Agent Plugins wiring, not a runtime flag: an
   * artifact built without the feature has nothing to project onto, so a
   * preset naming cloud placement is refused when it is saved rather than
   * saved and refused at every Start.
   */
  cloudSelectedCapabilities?: boolean
  /**
   * Where the runtime signing key lives. A deployment that names it accepts
   * the capabilities it mints for its own cloud roots; one that does not
   * serves Tasks to signed callers only.
   */
  signingEnv?: Record<string, string | undefined>
  /** The register a minted capability is checked against, so a revoked one is refused before its expiry. */
  passes?: SandboxPassRegister
}

/** The signed request a Tasks actor was minted from, for authority calls that act as the caller. */
export type TasksSignedAuth = (actor: TasksActor) => SignedControlPlaneAuth | undefined

/** The workspace owner a Tasks actor's grant resolved to, for an actor minted from a grant rather than a signature. */
export type TasksGrantOwner = (actor: TasksActor) => TasksCapabilityOwner | undefined

/**
 * Hosted Tasks over D1 and the signed control-plane identity.
 *
 * The scope is the organization the authority resolves for the caller, so a
 * task, a preset and a command receipt are all reachable only from inside the
 * organization they were written in; the owner is the caller's token subject,
 * which is what keeps a preset personal inside an organization whose members
 * can all read its tasks. Project and session access are not this feature's to
 * decide: both go back to the same workspace authority every other hosted
 * route asks.
 */
export function createHostedTasksComposition(input: HostedTasksCompositionInput): HostedTasksComposition {
  const authority = input.authority
  const owners = authority.resolveWorkspaceOwner?.bind(authority)
  const signingEnv = input.signingEnv
  // Both halves or neither: a grant whose owner this deployment cannot look
  // up would have to be believed on its own claims, so it is not accepted at
  // all.
  // A root's grant names its calling session in a request; whether that
  // session lives in the root is the session authority's answer for the
  // owner, the same one that opens a linked session.
  const sessions = authority.authorizeRuntimeSession?.bind(authority)
  const capability: TasksCapabilityPort | undefined = signingEnv && owners
    ? {
        verify: async (token) =>
          await verifyTasksCapability(token, signingEnv, input.passes ? { revoked: input.passes.revoked } : {})
            .catch(() => undefined),
        workspaceOwner: owners,
        ...(sessions
          ? {
              ownerMayReadSession: async (owner, session) =>
                await sessions({
                  principalKind: "user",
                  actorId: owner.actorId,
                  actorKind: "human",
                  sessionId: session.sessionId,
                  workspaceId: session.workspaceId,
                  action: "read",
                }).then(() => true, () => false),
            }
          : {}),
      }
    : undefined
  const identity = signedTasksIdentity({
    authority,
    signed: input.signed,
    ...(capability ? { capability } : {}),
  })
  const placements: TasksHostCapabilities["placements"] = input.cloudPlacement ? ["local", "cloud"] : ["local"]
  const store = createD1TasksStore({ database: input.database })
  return {
    routeContributions: [
      tasksRouteContribution({
        store,
        authorization: identity.authorization,
        authenticate: identity.authenticate,
        bridge: identity.bridge(
          input.bridge(
            identity.runtimePrincipal,
            (actor) => identity.principals.authOf(actor),
            (actor) => identity.principals.capabilityOf(actor)?.owner,
          ),
          store,
        ),
        capabilities: createTasksCapabilities({
          placements,
          // A root's own machine is half of the promise; the other half is the
          // Agent Plugins wiring that gives it its own capability set, which an
          // artifact built without that feature does not have. A preset naming
          // cloud placement is refused when it is saved rather than saved and
          // refused at every Start.
          cloudSelectedCapabilities: placements.includes("cloud") && input.cloudSelectedCapabilities === true,
        }),
      }),
    ],
  }
}
