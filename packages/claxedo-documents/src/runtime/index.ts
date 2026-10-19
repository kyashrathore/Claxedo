import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import type { DocumentHydration } from "./hydration"

export {
  createDocumentHydration,
  type DocumentHydration,
  type DocumentHydrationOptions,
  type DocumentHydrationScope,
} from "./hydration"

/**
 * Documents hydration as a workspace runtime contribution: the routes a
 * relay-exposed runtime serves, checked by its session authority, and the
 * write-back after each turn and before each delete. A runtime with any other
 * exposure mounts the routes but answers 404.
 */
export function documentHydrationContribution(hydration: DocumentHydration): WorkspaceRuntimeRouteContribution {
  return {
    id: "claxedo-documents",
    mount: (context) => ({
      path: "/",
      routes: hydration.routes({
        ...(context.relayWorkspaceId ? { workspaceId: context.relayWorkspaceId } : {}),
        authorizeSessionControl: context.authorizeSessionControl,
      }),
      dispose: hydration.forget,
    }),
    sessionLifecycle: {
      turnSettled: hydration.flushSession,
      beforeSessionDelete: hydration.disposeSession,
    },
  }
}
