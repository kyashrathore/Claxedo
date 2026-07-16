import type * as SDK from "@/app/providers/sdk/sdk"
import type * as GlobalSDK from "@/app/providers/global-sdk/provider"
import type * as SessionSync from "@/features/session/providers/session-sync"
import type * as State from "@/app/workbench/state"
import type * as MarkdownTab from "@/app/workbench/lib/open-markdown-page-tab"
import type * as QueryOptions from "@/app/integrations/sync/query-options"
import type * as ProjectEnsure from "@/features/workspaces/data/query/project-ensure"
import type * as SurfaceRoute from "@/app/workbench/state/surface-route"
import type * as SessionScope from "@/features/session/ui/components/session-pane-scope"
import type * as DocWorkGraph from "@/app/integrations/doc-workgraph"

export type DocumentsAppPorts = {
  useSDK: typeof SDK.useSDK
  useGlobalSDK: typeof GlobalSDK.useGlobalSDK
  useSessionSyncOptional: typeof SessionSync.useSessionSyncOptional
  useClaxedoState: typeof State.useClaxedoState
  markdownPathFromHref: typeof MarkdownTab.markdownPathFromHref
  useShellQueryOptions: typeof QueryOptions.useShellQueryOptions
  ensureLocalProject: typeof ProjectEnsure.ensureLocalProject
  surfaceRoute: typeof SurfaceRoute.surfaceRoute
  SessionPaneScope: typeof SessionScope.SessionPaneScope
  turnDocumentIntoWork: typeof DocWorkGraph.turnDocumentIntoWork
}

let ports: DocumentsAppPorts | undefined

export function configureDocumentsAppPorts(value: DocumentsAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Documents app ports are not configured")
  return ports
}

function bind<K extends keyof DocumentsAppPorts>(key: K) {
  return ((...args: never[]) => (required()[key] as (...values: never[]) => unknown)(...args)) as DocumentsAppPorts[K]
}

export const useSDK = bind("useSDK")
export const useGlobalSDK = bind("useGlobalSDK")
export const useSessionSyncOptional = bind("useSessionSyncOptional")
export const useClaxedoState = bind("useClaxedoState")
export const markdownPathFromHref = bind("markdownPathFromHref")
export const useShellQueryOptions = bind("useShellQueryOptions")
export const ensureLocalProject = bind("ensureLocalProject")
export const surfaceRoute = bind("surfaceRoute")
export const SessionPaneScope = bind("SessionPaneScope")
export const turnDocumentIntoWork = bind("turnDocumentIntoWork")
