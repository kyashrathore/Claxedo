import type { LocalServerPlugin } from "@claxedo/server-core/plugins/server-plugin"
import { BUILTIN_TASKS_TOOL_GROUP } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import {
  capabilityTasksAuthenticate,
  confineCapabilityBridge,
  createLocalTasksAuthorization,
  createTasksPrincipals,
  localTasksWorkspaceOwner,
  unsignedLocalTasksAuthenticate,
} from "@claxedo/server-core/tasks-host/authorization"
import { gateAgentStarts } from "@claxedo/server-core/tasks-host/agent-start-gates"
import { TASKS_OPERATIONS } from "@claxedo/server-core/tasks-host/capability"
import { tasksRouteContribution } from "@claxedo/server-core/tasks-host/contribution"
import { createTasksCapabilities } from "@claxedo/server-core/tasks-host/host-ports"
import { createTasksSessionGrants } from "@claxedo/server-core/tasks-host/session-grants"
import { sqliteTasksStore } from "@claxedo/server-core/tasks-host/sqlite-store"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { createLocalTasksSessionBridge } from "./session-bridge"

export type LocalTasksPluginInput = {
  /**
   * Whether this machine has the Tasks tools turned on, read at every issue
   * and every verify. The switch that hides the tools is the same decision as
   * the one that withdraws the handle they would act with, so a grant a
   * session is still holding stops answering the moment Tasks is turned off.
   * Absent means always on.
   */
  enabled?: () => boolean
}

/**
 * Enabled desktop-local Tasks. Only a product entry that composes this plugin
 * gets the feature: the routes, the SQLite tables and the kit itself stay out
 * of a build that does not, exactly as Agent Plugins does.
 *
 * Two callers reach these routes and they are not the same caller. The person
 * at this machine arrives over loopback with no grant, and the scope is the
 * machine and the owner is that one person. A model inside a session arrives
 * with the handle its MCP service grant carries, and is held to the workspace
 * that session runs in, the project that workspace sits in, and the
 * agent-start gates — the same capability path a hosted root's grant takes.
 * The registry that issues the handle and the routes that verify it are one
 * value here, so a host cannot mount one without the other.
 *
 * Presets are still filtered by owner, because the same pair is an
 * organization and one of its members on a hosted deployment and the kit's
 * rules must not differ between the two.
 */
export function createLocalTasksPlugin(input: LocalTasksPluginInput = {}): LocalServerPlugin {
  const principals = createTasksPrincipals()
  const grants = createTasksSessionGrants({
    workspaceOwner: async (workspaceId) => {
      const workspace = await resolveWorkspace({ workspaceId })
      return workspace ? localTasksWorkspaceOwner(workspace.project_id ?? workspace.id) : undefined
    },
    ...(input.enabled ? { enabled: input.enabled } : {}),
  })
  const { capability } = grants
  const routeContributions = [
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
  ]
  return {
    id: "claxedo-tasks",
    capability: "tasks",
    routeContributions: () => routeContributions,
    mcp: {
      service: {
        id: "tasks",
        // A session whose Tasks group is off, or whose workspace names no
        // owner, keeps the bare loopback fetch that reads as the person at
        // this machine.
        async grant({ workspaceId, sessionId, enabledGroups, inProcessFetch }) {
          const handle = enabledGroups.includes(BUILTIN_TASKS_TOOL_GROUP)
            ? await grants.issue({ workspaceId, ...(sessionId ? { sessionId } : {}) })
            : undefined
          return {
            fetch: inProcessFetch(handle ? { authorization: `Bearer ${handle}` } : { "x-workspace-id": workspaceId }),
            operations: TASKS_OPERATIONS,
          }
        },
      },
    },
  }
}
