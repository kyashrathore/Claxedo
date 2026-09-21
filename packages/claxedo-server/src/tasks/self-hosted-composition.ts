import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { signedTasksIdentity, tasksRouteContribution } from "@claxedo/server-core/tasks-host/contribution"
import { createTasksCapabilities } from "@claxedo/server-core/tasks-host/host-ports"
import { sqliteTasksStore } from "@claxedo/server-core/tasks-host/sqlite-store"
import { createLocalTasksSessionBridge } from "@claxedo/local-server/tasks/session-bridge"
import { createTasksSessionRelease, createTasksSessionReserve } from "./session-reservation"
import type { ControlPlaneServices } from "../authority/services"
import { signedOrError } from "../workspace/route-support"
import type { TasksSessionGrants } from "@claxedo/server-core/tasks-host/session-grants"

export type SelfHostedTasksComposition = {
  routeContributions: readonly ControlPlaneRouteContribution[]
}

export type SelfHostedTasksCompositionInput = {
  services: ControlPlaneServices
  /**
   * The grants this box hands its own sessions. Absent leaves a signed
   * self-host whose sessions carry no Tasks tools rather than one whose
   * routes admit a bearer nothing issued.
   */
  grants?: TasksSessionGrants
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
    // A session on this box carries no signed bearer of the person who started
    // it. Its grant is admitted by the same capability branch a cloud root's
    // is, resolved to the same workspace owner; only the shape of the handle
    // differs, because it never leaves this process.
    ...(input.grants ? { capability: input.grants.capability } : {}),
  })
  const reservation = { services: input.services, principal: identity.runtimePrincipal }
  return {
    routeContributions: [
      tasksRouteContribution({
        store: sqliteTasksStore,
        authorization: identity.authorization,
        authenticate: identity.authenticate,
        bridge: identity.bridge(
          createLocalTasksSessionBridge({
            reserve: createTasksSessionReserve(reservation),
            release: createTasksSessionRelease(reservation),
          }),
          sqliteTasksStore,
        ),
        // The local bridge this composition passes names no cloud target, so a
        // preset placed in the cloud is refused when it is saved rather than
        // saved and refused at every Start.
        capabilities: createTasksCapabilities({ placements: ["local"], cloudSelectedCapabilities: false }),
      }),
    ],
  }
}
