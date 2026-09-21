import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import {
  capabilityTasksAuthenticate,
  confineCapabilityBridge,
  createLocalTasksAuthorization,
  createTasksPrincipals,
  localTasksWorkspaceOwner,
  unsignedLocalTasksAuthenticate,
} from "@claxedo/server-core/tasks-host/authorization"
import { gateAgentStarts } from "@claxedo/server-core/tasks-host/agent-start-gates"
import { tasksRouteContribution } from "@claxedo/server-core/tasks-host/contribution"
import { createTasksCapabilities } from "@claxedo/server-core/tasks-host/host-ports"
import { createTasksSessionGrants, type TasksSessionGrants } from "@claxedo/server-core/tasks-host/session-grants"
import { sqliteTasksStore } from "@claxedo/server-core/tasks-host/sqlite-store"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { createLocalTasksSessionBridge } from "./session-bridge"

export type LocalTasksCompositionInput = {
  /**
   * Whether this machine has the Tasks tools turned on, read at every issue
   * and every verify. The switch that hides the tools is the same decision as
   * the one that withdraws the handle they would act with, so a grant a
   * session is still holding stops answering the moment Tasks is turned off.
   * Absent means always on.
   */
  enabled?: () => boolean
}

export type LocalTasksComposition = {
  routeContributions: readonly ControlPlaneRouteContribution[]
  /**
   * The grants this machine's own sessions present. The MCP mount issues one
   * per session and the routes below verify it, so the two are handed out
   * together: a mount that issued nothing would serve sessions no Tasks at
   * all, and routes composed without the registry would honour nothing it
   * issued.
   */
  grants: TasksSessionGrants
}

/**
 * Enabled desktop-local Tasks. Only a product entry that imports this module
 * gets the feature: the routes, the SQLite tables and the kit itself stay out
 * of a build that does not, exactly as Agent Plugins does.
 *
 * Two callers reach these routes and they are not the same caller. The person
 * at this machine arrives over loopback with no grant, and the scope is the
 * machine and the owner is that one person. A model inside a session arrives
 * with the handle its MCP mount issued, and is held to the workspace that
 * session runs in, the project that workspace sits in, and the agent-start
 * gates — the same capability path a hosted root's grant takes.
 *
 * Presets are still filtered by owner, because the same pair is an
 * organization and one of its members on a hosted deployment and the kit's
 * rules must not differ between the two.
 */
export function createLocalTasksComposition(input: LocalTasksCompositionInput = {}): LocalTasksComposition {
  const principals = createTasksPrincipals()
  const grants = createTasksSessionGrants({
    workspaceOwner: async (workspaceId) => {
      const workspace = await resolveWorkspace({ workspaceId })
      return workspace ? localTasksWorkspaceOwner(workspace.project_id ?? workspace.id) : undefined
    },
    ...(input.enabled ? { enabled: input.enabled } : {}),
  })
  const { capability } = grants
  return {
    grants,
    routeContributions: [
      tasksRouteContribution({
        store: sqliteTasksStore,
        authorization: createLocalTasksAuthorization(principals, capability),
        authenticate: capabilityTasksAuthenticate({
          capability,
          principals,
          signed: unsignedLocalTasksAuthenticate(principals),
        }),
        bridge: confineCapabilityBridge(
          principals,
          capability,
          gateAgentStarts(principals, capability, sqliteTasksStore, createLocalTasksSessionBridge()),
        ),
        // This machine runs the sessions it starts and has no cloud root to
        // isolate: a cloud preset is refused when it is saved rather than saved
        // and refused at Start.
        capabilities: createTasksCapabilities({ placements: ["local"], cloudSelectedCapabilities: false }),
      }),
    ],
  }
}
