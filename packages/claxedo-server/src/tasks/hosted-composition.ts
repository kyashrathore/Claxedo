import type { D1Database } from "@cloudflare/workers-types"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import type { WorkspaceRuntimeClientOptions } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { createTasksAuthorization, createTasksPrincipals, signedTasksAuthenticate } from "@claxedo/server-core/tasks-host/authorization"
import { createTasksCapabilities, randomTasksIds, systemTasksClock } from "@claxedo/server-core/tasks-host/host-ports"
import { TASKS_ROUTE_PATH, createTasksRoutes } from "@claxedo/tasks/http"
import type { TasksSessionBridgePort } from "@claxedo/tasks"
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
  bridge: TasksSessionBridgePort
  /** False on a deployment that composes no runtime able to hold a selected-only capability set. */
  cloudSelectedCapabilities: boolean
}

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
  const authority = requireAuthority(input.services)
  const principals = createTasksPrincipals()
  return {
    routeContributions: [
      {
        id: "claxedo-tasks",
        path: TASKS_ROUTE_PATH,
        routes: createTasksRoutes({
          store: createD1TasksStore({ database: input.database }),
          authorization: createTasksAuthorization({ authority, principals }),
          authenticate: signedTasksAuthenticate({
            authority,
            principals,
            signed: (request) =>
              signedOrError(request, { authentication: input.authentication, requireSigned: true }, input.services),
          }),
          bridge: input.bridge,
          capabilities: createTasksCapabilities({
            placements: ["local", "cloud"],
            cloudSelectedCapabilities: input.cloudSelectedCapabilities,
          }),
          clock: systemTasksClock(),
          ids: randomTasksIds(),
        }),
      },
    ],
  }
}
