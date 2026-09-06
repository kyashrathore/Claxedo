import type * as SessionSync from "@/features/session/providers/session-sync"
import type * as State from "@/app/workbench/state"
import type * as MarkdownTab from "@/app/workbench/lib/open-markdown-page-tab"
import type * as QueryOptions from "@/app/integrations/sync/query-options"
import type * as ProjectEnsure from "@/features/workspaces/data/query/project-ensure"
import type * as SurfaceRoute from "@/app/workbench/state/surface-route"
import type * as SessionScope from "@/features/session/ui/components/session-pane-scope"
import type * as Events from "@/app/integrations/claxedo-events"

export type DocumentsAppPorts = {
  /**
   * Central events stream — the `document.changed`
   * doorbell that replaced the index surface's own `/documents/events` SSE.
   *
   * REQUIRED as of Wave 3: `app/integrations/feature-ports.ts` (production) and
   * `app/integrations/test-support/app-ports-stub.ts` (tests) both supply it, so
   * the type no longer has to tolerate its absence. It stays the *Optional*
   * variant of the hook because the hook itself returns `undefined` outside a
   * `ClaxedoEventsProvider` — a Documents surface rendered without the events
   * provider degrades to load-on-open + refresh-on-focus rather than crashing,
   * and `createDocumentIndexController` warns once so that cannot rot silently.
   */
  useClaxedoEventsOptional: typeof Events.useClaxedoEventsOptional
  useSessionSyncOptional: typeof SessionSync.useSessionSyncOptional
  useClaxedoState: typeof State.useClaxedoState
  markdownPathFromHref: typeof MarkdownTab.markdownPathFromHref
  useShellQueryOptions: typeof QueryOptions.useShellQueryOptions
  ensureLocalProject: typeof ProjectEnsure.ensureLocalProject
  surfaceRoute: typeof SurfaceRoute.surfaceRoute
  SessionPaneScope: typeof SessionScope.SessionPaneScope
}

let ports: DocumentsAppPorts | undefined

export function configureDocumentsAppPorts(value: DocumentsAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Documents app ports are not configured")
  return ports
}

/**
 * A lazy stand-in for one port: the shell configures the ports after this module
 * is evaluated, so each export must defer the lookup to call time. Reading the
 * port through `select` keeps the argument and return types inferred from the
 * real function, which is why no cast is needed to produce one.
 */
function bind<A extends unknown[], R>(select: (ports: DocumentsAppPorts) => (...args: A) => R) {
  return (...args: A) => select(required())(...args)
}

/**
 * Not `bind()`: that helper assumes the port exists and would call `undefined`.
 * This returns the hook itself so a caller can branch on absence (see the
 * `useClaxedoEventsOptional` note above).
 */
export function claxedoEventsPort() {
  return ports?.useClaxedoEventsOptional
}

export const useSessionSyncOptional = bind((ports) => ports.useSessionSyncOptional)
export const useClaxedoState = bind((ports) => ports.useClaxedoState)
export const markdownPathFromHref = bind((ports) => ports.markdownPathFromHref)
export const useShellQueryOptions = bind((ports) => ports.useShellQueryOptions)
export const ensureLocalProject = bind((ports) => ports.ensureLocalProject)
export const surfaceRoute = bind((ports) => ports.surfaceRoute)
export const SessionPaneScope = bind((ports) => ports.SessionPaneScope)
