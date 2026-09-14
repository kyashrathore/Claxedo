/**
 * What every Tasks composition shares, so a composition names only what makes
 * it that product.
 *
 * The kit is mounted identically on all three postures — the same route id, the
 * same path, a wall clock and random ids — and the identity half is the same on
 * both signed ones: one principal registry, the hosted authorization port that
 * asks the workspace authority, and the authenticator that mints an actor from
 * the deployment's own signed-request reader. What differs is the store, the
 * bridge and the placements, which is what a composition still spells out.
 */
import { TASKS_ROUTE_PATH, createTasksRoutes, type TasksAuthenticate } from "@claxedo/tasks/http"
import type {
  TasksAuthorizationPort,
  TasksCapabilitiesPort,
  TasksSessionBridgePort,
  TasksStoreOperations,
  TasksStorePort,
} from "@claxedo/tasks"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import {
  capabilityTasksAuthenticate,
  confineCapabilityBridge,
  createTasksAuthorization,
  createTasksPrincipals,
  signedTasksAuthenticate,
  signedTasksRuntimePrincipal,
  type SignedTasksAuthenticateInput,
  type TasksPrincipals,
  type TasksRuntimePrincipal,
} from "./authorization"
import { gateAgentStarts } from "./agent-start-gates"
import type { TasksCapabilityPort } from "./capability"
import { randomTasksIds, systemTasksClock } from "./host-ports"

export type TasksRouteContributionInput = {
  store: TasksStorePort
  authorization: TasksAuthorizationPort
  authenticate: TasksAuthenticate
  bridge: TasksSessionBridgePort
  capabilities: TasksCapabilitiesPort
}

export function tasksRouteContribution(input: TasksRouteContributionInput): ControlPlaneRouteContribution {
  return {
    id: "claxedo-tasks",
    path: TASKS_ROUTE_PATH,
    routes: createTasksRoutes({ ...input, clock: systemTasksClock(), ids: randomTasksIds() }),
  }
}

export type SignedTasksIdentity = {
  principals: TasksPrincipals
  authorization: TasksAuthorizationPort
  authenticate: TasksAuthenticate
  /** The canonical human a session is reserved for, for a host whose authority records a creator. */
  runtimePrincipal: TasksRuntimePrincipal
  /**
   * The composition's bridge behind the capability's Start doors: the scope
   * confinement, then the agent-start gates, which read the store the
   * composition mounts. A signed composition that mounts its bridge bare lets
   * a grant start a task the owner pointed at another project's workspace,
   * or start a cloud machine from a preset nobody marked for agents.
   */
  bridge(bridge: TasksSessionBridgePort, store: Pick<TasksStoreOperations, "tasks" | "links">): TasksSessionBridgePort
}

export function signedTasksIdentity(input: {
  authority: WorkspaceAuthority
  signed: SignedTasksAuthenticateInput["signed"]
  /**
   * The grant a session's agent carries. Absent on a deployment that mints
   * none, and then a request is admitted only by the signed identity — which
   * is what keeps a build with no capability minting from accepting one.
   */
  capability?: TasksCapabilityPort
}): SignedTasksIdentity {
  const principals = createTasksPrincipals()
  const signed = signedTasksAuthenticate({ authority: input.authority, principals, signed: input.signed })
  const capability = input.capability
  return {
    principals,
    authorization: createTasksAuthorization({ authority: input.authority, principals, ...(capability ? { capability } : {}) }),
    authenticate: capability ? capabilityTasksAuthenticate({ capability, principals, signed }) : signed,
    runtimePrincipal: signedTasksRuntimePrincipal(principals),
    bridge: (bridge, store) =>
      capability ? confineCapabilityBridge(principals, capability, gateAgentStarts(principals, store, bridge)) : bridge,
  }
}
