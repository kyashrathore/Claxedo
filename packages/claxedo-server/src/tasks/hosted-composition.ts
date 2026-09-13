import type { D1Database } from "@cloudflare/workers-types"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import type { WorkspaceRuntimeClientOptions } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import type { TasksRuntimePrincipal } from "@claxedo/server-core/tasks-host/authorization"
import { signedTasksIdentity, tasksRouteContribution } from "@claxedo/server-core/tasks-host/contribution"
import { createTasksCapabilities } from "@claxedo/server-core/tasks-host/host-ports"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { TasksActor, TasksHostCapabilities, TasksSessionBridgePort } from "@claxedo/tasks"
import type { ControlPlaneServices } from "../authority/services"
import { signedOrError } from "../workspace/route-support"
import { createD1TasksStore } from "./d1-store"

export type HostedTasksComposition = {
  routeContributions: readonly ControlPlaneRouteContribution[]
}

export type HostedTasksCompositionInput = {
  services: ControlPlaneServices
  database: D1Database
  authentication: RequestAuthenticationAdapter
  /**
   * Built here rather than passed in, because the bridge has to reserve each
   * session — and create a cloud root's own workspace — as the person who
   * started it, and only this composition holds the registry that maps a Tasks
   * actor back to that person.
   */
  bridge: (principal: TasksRuntimePrincipal, auth: TasksSignedAuth) => TasksSessionBridgePort
  /**
   * Whether this deployment can project a cloud root's selected capability
   * set. It is the build's Agent Plugins wiring, not a runtime flag: an
   * artifact built without the feature has nothing to project onto, so a
   * preset naming cloud placement is refused when it is saved rather than
   * saved and refused at every Start.
   */
  cloudSelectedCapabilities?: boolean
}

/** The signed request a Tasks actor was minted from, for authority calls that act as the caller. */
export type TasksSignedAuth = (actor: TasksActor) => SignedControlPlaneAuth | undefined

/**
 * The runtime principal Tasks dispatches as. Start reserves and creates a
 * session before any human turn exists, so it acts as the one control-plane
 * service actor the D1 runtime authority mints service tokens for — the same
 * actor the checkpoint routes and the Agent Plugins provisioner use.
 */
export function hostedTasksRuntimeClient(services: ControlPlaneServices): WorkspaceRuntimeClientOptions {
  return {
    ...(services.sandbox.sandboxManager ? { sandboxManager: services.sandbox.sandboxManager } : {}),
    ...(services.relay.provider ? { relayProvider: services.relay.provider } : {}),
    ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
    runtimeActor: { principalKind: "service", actorId: "control-plane", actorKind: "agent" },
    role: "owner",
  }
}

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
  const identity = signedTasksIdentity({
    authority: requireAuthority(input.services),
    signed: (request) =>
      signedOrError(request, { authentication: input.authentication, requireSigned: true }, input.services),
  })
  // The same reading the workspace routes make before they will create a
  // cloud workspace at all: without a sandbox manager this deployment has no
  // isolated root to allocate.
  const placements: TasksHostCapabilities["placements"] = input.services.sandbox.sandboxManager
    ? ["local", "cloud"]
    : ["local"]
  return {
    routeContributions: [
      tasksRouteContribution({
        store: createD1TasksStore({ database: input.database }),
        authorization: identity.authorization,
        authenticate: identity.authenticate,
        bridge: input.bridge(identity.runtimePrincipal, (actor) => identity.principals.authOf(actor)),
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
