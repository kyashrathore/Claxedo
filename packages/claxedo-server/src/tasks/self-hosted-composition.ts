import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { signedTasksIdentity, tasksRouteContribution } from "@claxedo/server-core/tasks-host/contribution"
import { createTasksCapabilities } from "@claxedo/server-core/tasks-host/host-ports"
import { sqliteTasksStore } from "@claxedo/server-core/tasks-host/sqlite-store"
import { createLocalTasksSessionBridge } from "@claxedo/local-server/tasks/session-bridge"
import { createTasksSessionRelease, createTasksSessionReserve } from "./session-reservation"
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
  const identity = signedTasksIdentity({
    authority,
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
  })
  const reservation = { services: input.services, principal: identity.runtimePrincipal }
  return {
    routeContributions: [
      tasksRouteContribution({
        store: sqliteTasksStore,
        authorization: identity.authorization,
        authenticate: identity.authenticate,
        bridge: createLocalTasksSessionBridge({
          reserve: createTasksSessionReserve(reservation),
          release: createTasksSessionRelease(reservation),
        }),
        // The local bridge this composition passes names no cloud target, so a
        // preset placed in the cloud is refused when it is saved rather than
        // saved and refused at every Start.
        capabilities: createTasksCapabilities({ placements: ["local"], cloudSelectedCapabilities: false }),
      }),
    ],
  }
}
