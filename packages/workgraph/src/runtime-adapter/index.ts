import type {
  WorkspaceRuntimeRouteContribution,
  WorkspaceRuntimeRouteContext,
} from "@claxedo/workspace-runtime/route-contribution"
import {
  WorkGraphConnectionToolRoutes,
  type WorkGraphConnectionBrokerRequestLimits,
  type WorkGraphConnectionOperationBroker,
} from "./workgraph-connection-tools"
import { WorkGraphRunToolRoutes, type WorkGraphRunOperationBroker } from "./workgraph-run-tools"

/**
 * WorkGraph's Workspace Runtime adapter.
 *
 * These two route groups used to live inside `@claxedo/workspace-runtime` and
 * mount on every runtime instance. That put `@claxedo/workgraph` in the
 * runtime's dependency closure, which meant a desktop-local build could not be
 * shown to exclude WorkGraph no matter what the UI did — the lower layer
 * dragged it back in.
 *
 * The code is unchanged; only its owner and its mounting condition are. The
 * hosted runtime launcher passes these contributions explicitly and the
 * desktop-local embedded runtime passes none, so "does this build contain
 * WorkGraph" becomes a property of the composition rather than of a flag.
 *
 * Ownership direction is deliberate: WorkGraph depends on Workspace Runtime's
 * published contribution and HTTP contracts, never the reverse. That is the
 * whole point — a lower execution core must not know about a product
 * capability layered on top of it.
 */

export type WorkGraphRuntimeAdapterOptions = {
  connection?: {
    broker?: WorkGraphConnectionOperationBroker
    /** Exact central origin allowed to receive the bound Runtime Access Token. */
    brokerOrigin?: string
    brokerRequestLimits?: WorkGraphConnectionBrokerRequestLimits
  }
  run?: {
    broker?: WorkGraphRunOperationBroker
    brokerOrigin?: string
  }
}

/**
 * Session-tool group names.
 *
 * Exported because they are part of the contract, not an implementation
 * detail: the runtime merges tool registrations by group, so a second
 * contribution reusing `"connections"` would silently replace WorkGraph's
 * tools for that session rather than being rejected.
 */
export const WORKGRAPH_CONNECTION_TOOL_GROUP = "connections"
export const WORKGRAPH_RUN_TOOL_GROUP = "run"

export const WORKGRAPH_CONNECTION_CONTRIBUTION_ID = "workgraph.connection-tools"
export const WORKGRAPH_RUN_CONTRIBUTION_ID = "workgraph.run-tools"

function connectionContribution(
  options: WorkGraphRuntimeAdapterOptions["connection"],
): WorkspaceRuntimeRouteContribution {
  return {
    id: WORKGRAPH_CONNECTION_CONTRIBUTION_ID,
    mount(runtime: WorkspaceRuntimeRouteContext) {
      const routes = WorkGraphConnectionToolRoutes({
        workspaceId: runtime.workspaceId,
        ...(options?.broker ? { broker: options.broker } : {}),
        ...(options?.brokerOrigin ? { brokerOrigin: options.brokerOrigin } : {}),
        ...(options?.brokerRequestLimits ? { brokerRequestLimits: options.brokerRequestLimits } : {}),
        registerSessionTools: runtime.registerSessionTools(WORKGRAPH_CONNECTION_TOOL_GROUP),
        unregisterSessionTools: runtime.unregisterSessionTools(WORKGRAPH_CONNECTION_TOOL_GROUP),
      })
      return { path: "/", routes, dispose: () => routes.dispose() }
    },
  }
}

function runContribution(options: WorkGraphRuntimeAdapterOptions["run"]): WorkspaceRuntimeRouteContribution {
  return {
    id: WORKGRAPH_RUN_CONTRIBUTION_ID,
    mount(runtime: WorkspaceRuntimeRouteContext) {
      const routes = WorkGraphRunToolRoutes({
        workspaceId: runtime.workspaceId,
        ...(options?.broker ? { broker: options.broker } : {}),
        ...(options?.brokerOrigin ? { brokerOrigin: options.brokerOrigin } : {}),
        registerSessionTools: runtime.registerSessionTools(WORKGRAPH_RUN_TOOL_GROUP),
        unregisterSessionTools: runtime.unregisterSessionTools(WORKGRAPH_RUN_TOOL_GROUP),
      })
      return { path: "/", routes, dispose: () => routes.dispose() }
    },
  }
}

/**
 * Both WorkGraph route groups, ready to hand to `mountRouteContributions`.
 *
 * Returned as an array rather than mounted here so the host keeps one
 * composition point for every contribution it adds, and so a host that wants
 * only one group can take it.
 */
export function workGraphRuntimeRouteContributions(
  options: WorkGraphRuntimeAdapterOptions = {},
): WorkspaceRuntimeRouteContribution[] {
  return [connectionContribution(options.connection), runContribution(options.run)]
}

export {
  WorkGraphConnectionToolRoutes,
  WORKGRAPH_CONNECTION_TOOL_NAMES,
  WorkGraphConnectionOperationRequestSchema,
  WorkGraphConnectionOperationResponseSchema,
  type WorkGraphConnectionBrokerRequestLimits,
  type WorkGraphConnectionOperationBroker,
  type WorkGraphConnectionOperationRequest,
  type WorkGraphConnectionOperationResponse,
  type WorkGraphConnectionToolInput,
  type WorkGraphConnectionToolName,
  type WorkGraphConnectionToolRouteHandle,
} from "./workgraph-connection-tools"
export {
  WorkGraphRunToolRoutes,
  WORKGRAPH_RUN_TOOL_NAMES,
  type WorkGraphRunOperationBroker,
  type WorkGraphRunToolRouteHandle,
} from "./workgraph-run-tools"
