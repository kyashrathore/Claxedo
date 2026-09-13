import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import {
  createTasksAuthorization,
  createTasksPrincipals,
  signedTasksAuthenticate,
  signedTasksRuntimePrincipal,
} from "@claxedo/server-core/tasks-host/authorization"
import { createTasksCapabilities, randomTasksIds, systemTasksClock } from "@claxedo/server-core/tasks-host/host-ports"
import { sqliteTasksStore } from "@claxedo/server-core/tasks-host/sqlite-store"
import { createLocalTasksSessionBridge } from "@claxedo/local-server/tasks/session-bridge"
import { createTasksSessionRelease, createTasksSessionReserve } from "./session-bridge"
import { TASKS_ROUTE_PATH, createTasksRoutes } from "@claxedo/tasks/http"
import type { ControlPlaneServices } from "../authority/services"
import { signedOrError } from "../workspace/route-support"

export type SelfHostedTasksComposition = {
  routeContributions: readonly ControlPlaneRouteContribution[]
}

export type SelfHostedTasksCompositionInput = {
  services: ControlPlaneServices
}

/**
 * Self-hosted Tasks for the SIGNED posture: this box's own SQLite tables, and
 * the identity every other signed route on it reads — the embedded issuer's
 * bearer verifier behind `services.auth`, and the local SQLite workspace
 * authority behind `services.authority`.
 *
 * `@claxedo/local-server/tasks/local-composition` remains the UNSIGNED
 * posture's composition and is not interchangeable with this one: it admits a
 * request because it came from loopback, mints one local owner for every
 * caller, and authorizes every project unconditionally. Serving that to a
 * signed multi-user self-host would hand every remote member the same personal
 * preset catalog and refuse anyone who did not reach the box over loopback.
 *
 * The session bridge is the local one either way, because this box runs the
 * sessions it starts. It still reserves each session for the signed person
 * who started it: session access is granted to a creator actor, and a session
 * created with no reservation is one its starter cannot open.
 */
export function createSelfHostedTasksComposition(
  input: SelfHostedTasksCompositionInput,
): SelfHostedTasksComposition {
  const authority = requireAuthority(input.services)
  const principals = createTasksPrincipals()
  return {
    routeContributions: [
      {
        id: "claxedo-tasks",
        path: TASKS_ROUTE_PATH,
        routes: createTasksRoutes({
          store: sqliteTasksStore,
          authorization: createTasksAuthorization({ authority, principals }),
          authenticate: signedTasksAuthenticate({
            authority,
            principals,
            signed: (request) =>
              signedOrError(
                request,
                {
                  authConfig: input.services.auth.config,
                  ...(input.services.auth.verifier ? { verifier: input.services.auth.verifier } : {}),
                  requireSigned: true,
                },
                input.services,
              ),
          }),
          bridge: createLocalTasksSessionBridge({
            reserve: createTasksSessionReserve({
              services: input.services,
              principal: signedTasksRuntimePrincipal(principals),
            }),
            release: createTasksSessionRelease({
              services: input.services,
              principal: signedTasksRuntimePrincipal(principals),
            }),
          }),
          // `resolveStart` in session-bridge-core refuses cloud placement on
          // every host, so a preset naming one is refused when it is saved
          // rather than saved and refused at Start.
          capabilities: createTasksCapabilities({ placements: ["local"], cloudSelectedCapabilities: false }),
          clock: systemTasksClock(),
          ids: randomTasksIds(),
        }),
      },
    ],
  }
}
