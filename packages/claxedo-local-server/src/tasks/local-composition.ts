import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import {
  createLocalTasksAuthorization,
  createTasksPrincipals,
  loopbackTasksAuthenticate,
} from "@claxedo/server-core/tasks-host/authorization"
import { tasksRouteContribution } from "@claxedo/server-core/tasks-host/contribution"
import { createTasksCapabilities } from "@claxedo/server-core/tasks-host/host-ports"
import { sqliteTasksStore } from "@claxedo/server-core/tasks-host/sqlite-store"
import { createLocalTasksSessionBridge } from "./session-bridge"

export type LocalTasksComposition = {
  routeContributions: readonly ControlPlaneRouteContribution[]
}

/**
 * Enabled desktop-local Tasks. Only a product entry that imports this module
 * gets the feature: the routes, the SQLite tables and the kit itself stay out
 * of a build that does not, exactly as Agent Plugins does.
 *
 * The caller is the person at this machine — the routes admit loopback
 * requests only — so the scope is the machine and the owner is that one
 * person. Presets are still filtered by owner, because the same pair is an
 * organization and one of its members on a hosted deployment and the kit's
 * rules must not differ between the two.
 */
export function createLocalTasksComposition(): LocalTasksComposition {
  const principals = createTasksPrincipals()
  return {
    routeContributions: [
      tasksRouteContribution({
        store: sqliteTasksStore,
        authorization: createLocalTasksAuthorization(),
        authenticate: loopbackTasksAuthenticate(principals),
        bridge: createLocalTasksSessionBridge(),
        // This machine runs the sessions it starts and has no cloud root to
        // isolate: a cloud preset is refused when it is saved rather than saved
        // and refused at Start.
        capabilities: createTasksCapabilities({ placements: ["local"], cloudSelectedCapabilities: false }),
      }),
    ],
  }
}
