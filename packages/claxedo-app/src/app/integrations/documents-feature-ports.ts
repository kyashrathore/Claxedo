import { configureDocumentsAppPorts } from "@/features/documents/app-ports"
import * as Events from "@/app/integrations/claxedo-events"
import * as SessionSync from "@/features/session/providers/session-sync"
import * as State from "@/app/workbench/state"
import * as MarkdownTab from "@/app/workbench/lib/open-markdown-page-tab"
import * as QueryOptions from "@/app/integrations/sync/query-options"
import * as ProjectEnsure from "@/features/workspaces/data/query/project-ensure"
import * as SurfaceRoute from "@/app/workbench/state/surface-route"
import * as SessionScope from "@/features/session/ui/components/session-pane-scope"
import * as DocWorkGraph from "@/app/integrations/doc-workgraph"

configureDocumentsAppPorts({
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
  useSessionSyncOptional: SessionSync.useSessionSyncOptional,
  useClaxedoState: State.useClaxedoState,
  markdownPathFromHref: MarkdownTab.markdownPathFromHref,
  useShellQueryOptions: QueryOptions.useShellQueryOptions,
  ensureLocalProject: ProjectEnsure.ensureLocalProject,
  surfaceRoute: SurfaceRoute.surfaceRoute,
  SessionPaneScope: SessionScope.SessionPaneScope,
  turnDocumentIntoWork: DocWorkGraph.turnDocumentIntoWork,
})
