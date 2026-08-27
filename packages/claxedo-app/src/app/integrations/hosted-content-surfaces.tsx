import { For, type JSX, lazy, Show, Suspense } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useClaxedoState } from "../workbench/state/index"
import { isGlobalPanelMode } from "../../features/workspaces/ui/panel/workspace-panel-state"
import { workGraphPanelBodySlot, workGraphPanelHeaderSlot } from "@/ui/controls/portal-slot"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { newTaskRoute, sessionRoute } from "@/platform/identity/route"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useLayout } from "@/app/providers/layout"
import { workGraphExecutionContext } from "./workgraph-execution-context"
import { workGraphLocalProjectOptions } from "./workgraph-local-projects"
import { DialogSelectDirectory } from "@/app/dialogs/select-directory"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { ensureLocalProject } from "@/features/workspaces/data/query/project-ensure"
import { WorkGraphContent } from "../../features/workgraph"
import { appProjectWorkGraphKey } from "../../features/workgraph/project-key"
import { TaskComposerView } from "@/app/workbench/workgraph/task-composer-view"
import { SessionPaneScope } from "@/features/session/ui/components/session-pane-scope"
import type { WorkGraphSessionReference } from "@/features/workgraph/api"
import { bypassFetchThrottle } from "@/lib/fetch-throttle"
import { isHarnessId, sessionRefForWorkspaceSession, type SessionRef } from "@/platform/identity/session-ref"
import { routeBridgeClaxedoSessionMetaUrl, routeSessionWorkspaceBacking } from "@/app/workbench/state/route-bridge-resolution"
import { sessionInventoryTarget, type RouteIntentInventory } from "@/app/workbench/state/route-intent"
import { sessionInventoryQueryOptions } from "@/features/session/data/sync/queries"
import type { SessionInventoryRow } from "@/features/session/data/query/types"
import { SurfaceFallback } from "./surface-fallback"
import type { ContentSurfaceContribution, ContentSurfaceRenderContext } from "./content-surface-contract"
import { workspaceRouteId, type WorkspaceRouteProject } from "@/platform/identity/workspace-route"

/**
 * Hosted content surfaces: WorkGraph and Documents.
 *
 * These used to sit beside the local surfaces in
 * `first-party-content-surfaces.tsx`, which made `WorkGraphContent` a static
 * import of the app's only entry. Lazy-loading the RENDERER would not have
 * helped: the module still had to be reachable from the local graph for the
 * `lazy()` call to name it, so `@claxedo/workgraph` stayed in the desktop's
 * dependency closure either way.
 *
 * Separating the module is what changes that. The local composition never
 * imports this file; the hosted contribution entry does, and only after an
 * account adapter reports signed state. WorkGraph and Documents then become a
 * property of which build you are running rather than of a feature flag.
 */

const PageContent = lazy(() => import("../../features/documents/ui/content/page-content").then((m) => ({ default: m.PageContent })))
const PagesIndexContent = lazy(() => import("../../features/documents/ui/content/pages-index-content").then((m) => ({ default: m.PagesIndexContent })))

type WorkGraphSessionTarget = {
  directory: NonNullable<SessionRef["cwd"]>
  sessionId: string
  title: string
  sessionRef: SessionRef
}

function WorkGraphSurface(props: { context: ContentSurfaceRenderContext; projectKey?: string }) {
  const platform = usePlatform()
  const state = useClaxedoState()
  const navigate = useNavigate()
  const queryOptions = useQueryOptions()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const layout = useLayout()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const sessionInventoryQuery = useQuery(() => sessionInventoryQueryOptions<SessionInventoryRow>({ baseUrl: globalSDK.url }))
  // Bridge WorkGraph's "Needs you" / Settings controls to the one shared
  // WorkspacePanel. WorkGraph owns no workspace, so it drives the panel as a
  // global-navigation surface and portals its views into the panel slots.
  const panelState = () => state.workspacePanel.state()
  const panel = {
    // The selected WorkGraph tab, reflected even while the panel animates closed
    // so its content stays warm-mounted (and non-tabbable) until fully hidden.
    mode: () => {
      const mode = panelState().mode
      if (!isGlobalPanelMode(mode)) return undefined
      if (mode === "workgraph-settings") return "settings" as const
      if (mode === "workgraph-tasks") return "tasks" as const
      return "attention" as const
    },
    isOpen: () => panelState().open,
    identity: panelState,
    open: (view: "attention" | "settings" | "tasks") =>
      state.workspacePanel.openGlobal(view === "settings" ? "workgraph-settings" : view === "tasks" ? "workgraph-tasks" : "workgraph-attention"),
    close: () => state.workspacePanel.close(),
    headerSlot: workGraphPanelHeaderSlot,
    bodySlot: workGraphPanelBodySlot,
  }
  const directory = () => props.context.meta.directory ?? props.context.fallbackDirectory?.()
  const executionContext = () => {
    const current = directory()?.trim()
    if (!current) return undefined
    return workGraphExecutionContext(current, projectsQuery.data ?? [])
  }
  // The picker offers the SAME projects the rail shows — `layout.projects.list()`,
  // the open-project list — not the raw `/project` catalog. The catalog is seeded
  // asynchronously and can still be empty while a project is open, which left the
  // dialog offering only "Choose another folder…" for a project already on screen.
  const localProjects = () =>
    workGraphLocalProjectOptions(layout.projects.list() ?? [], projectsQuery.data ?? [])
  // Always the in-app directory picker — the same component New Project uses —
  // never the OS-native dialog, so choosing a folder here looks and behaves like
  // the rest of the app.
  const chooseLocalProject = async () => {
    const result = await new Promise<string | string[] | null>((resolve) => {
      let selected = false
      dialog.show(
        () => (
          <DialogSelectDirectory
            onSelect={(directory) => {
              selected = true
              resolve(directory)
            }}
          />
        ),
        () => {
          if (!selected) resolve(null)
        },
      )
    })
    const directory = Array.isArray(result) ? result[0] : result
    if (!directory) return undefined
    await ensureLocalProject({
      baseUrl: globalSDK.url,
      request: platform.fetch,
      directory,
      projectsQuery: queryOptions.projects(),
    })
    // Registration alone only teaches the server. Opening it records the same
    // project in the persisted sidebar store, so picking a folder here makes it
    // stick everywhere — the rail and this picker both show it after a restart.
    layout.projects.open(directory)
    return directory
  }
  const openSession = (reference: WorkGraphSessionReference) =>
    openWorkGraphSession({
      reference,
      request: platform.fetch ?? fetch,
      serverUrl: globalSDK.url,
      projects: projectsQuery.data ?? [],
      inventory: sessionInventoryQuery.data,
      open: (target) => {
        state.layout.openSession(target.directory, target.sessionId, target.title, { sessionRef: target.sessionRef })
      },
      navigate,
    })
  return (
    <WorkGraphContent
      active={props.context.ctx.isVisible}
      request={platform.fetch}
      panel={panel}
      executionContext={executionContext()}
      localProjects={localProjects()}
      onChooseLocalProject={chooseLocalProject}
      onOpenSession={openSession}
      projectKey={props.projectKey}
    />
  )
}

function WorkspaceWorkGraphSurface(props: { context: ContentSurfaceRenderContext }) {
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const directory = props.context.meta.directory
  const projectKey = () => {
    if (!directory) return undefined
    const execution = workGraphExecutionContext(directory, projectsQuery.data ?? [])
    if (execution?.kind === "hosted_workspace") return `hosted:${execution.repositoryUrl}`
    const project = (projectsQuery.data ?? []).find((candidate) => candidate.worktree === directory)
    return appProjectWorkGraphKey(project ?? { worktree: directory }, directory)
  }
  return <WorkGraphSurface context={props.context} projectKey={projectKey()} />
}

export function taskComposerProjectTarget(project: WorkspaceRouteProject, directory = project.worktree ?? undefined) {
  const routeId = workspaceRouteId([project], directory)
  return routeId ? { workspaceRouteId: routeId, route: newTaskRoute(routeId) } : undefined
}

function TaskComposerSurface(props: { context: ContentSurfaceRenderContext }) {
  const platform = usePlatform()
  const state = useClaxedoState()
  const navigate = useNavigate()
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const retarget = (nextDirectory: string, project: WorkspaceRouteProject) => {
    const target = taskComposerProjectTarget(project, nextDirectory)
    if (!target) return
    state.meta.patch(props.context.meta.id, {
      directory: nextDirectory,
      scope: "directory",
      content: {
        type: "task-composer",
        directory: nextDirectory,
        title: "New task",
        workspaceRouteId: target.workspaceRouteId,
      },
    })
    navigate(target.route, { replace: true })
  }
  return (
    <Show
      keyed
      when={props.context.meta.directory}
      fallback={
        <main class="flex size-full items-center justify-center bg-background-base p-6" aria-label="Choose a project for the task">
          <section class="w-full max-w-md rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-sm">
            <h1 class="text-base font-medium text-text-base">Where should this task live?</h1>
            <p class="mt-1 text-sm text-text-weaker">Choose a project before composing the task.</p>
            <div class="mt-3 space-y-1">
              <For each={projectsQuery.data ?? []}>
                {(project) => (
                  <button
                    type="button"
                    class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-text-base hover:bg-surface-base-hover"
                    onClick={() => retarget(project.worktree, project)}
                  >
                    <span class="truncate">{project.name?.trim() || project.worktree.split("/").filter(Boolean).at(-1)}</span>
                    <span class="ml-3 truncate text-xs text-text-weaker">{project.worktree}</span>
                  </button>
                )}
              </For>
            </div>
          </section>
        </main>
      }
    >
      {(directory) => (
        <SessionPaneScope directory={directory} active={props.context.ctx.isVisible} paneId={() => props.context.ctx.paneId} surfaceId={() => props.context.meta.id}>
          <TaskComposerView directory={directory} request={platform.fetch} onRetarget={retarget} />
        </SessionPaneScope>
      )}
    </Show>
  )
}

export async function openWorkGraphSession(input: {
  reference: WorkGraphSessionReference
  request: typeof fetch
  serverUrl?: string
  projects: Parameters<typeof routeSessionWorkspaceBacking>[0]["projects"]
  inventory?: RouteIntentInventory
  open: (target: WorkGraphSessionTarget) => void
  navigate: (path: string) => void
}) {
  const inventoryTarget = input.inventory ? sessionInventoryTarget(input.reference.sessionId, input.inventory) : undefined
  if (inventoryTarget?.sessionRef) {
    input.open({
      directory: inventoryTarget.directory,
      sessionId: input.reference.sessionId,
      title: inventoryTarget.title ?? "Session",
      sessionRef:
        input.reference.harness && isHarnessId(input.reference.harness) ? { ...inventoryTarget.sessionRef, harness: { id: input.reference.harness } } : inventoryTarget.sessionRef,
    })
    input.navigate(sessionRoute(input.reference.sessionId))
    return
  }

  const response = await input.request(
    routeBridgeClaxedoSessionMetaUrl({
      serverUrl: input.serverUrl,
      sessionID: input.reference.sessionId,
    }),
    bypassFetchThrottle({}),
  )
  if (!response.ok) throw new Error(`Session unavailable (${response.status})`)

  const session = record(await response.json())
  const sessionId = string(session?.sessionID) ?? string(session?.sessionId)
  if (sessionId && sessionId !== input.reference.sessionId) throw new Error("Session metadata did not match the requested Session")
  const directory = string(session?.directory)
  if (!directory || directory === "/workspace") throw new Error("Session project is unavailable")
  const workspaceId = string(session?.workspaceID) ?? string(session?.workspaceId)
  const catalogWorkspace = routeSessionWorkspaceBacking({
    projects: input.projects,
    directory,
    workspaceId,
  })
  const workspace = catalogWorkspace ?? (input.reference.environment?.kind === "hosted_workspace" && workspaceId ? { workspaceId, kind: "cloud" as const } : undefined)
  const sessionRef = sessionRefForWorkspaceSession({
    sessionId: input.reference.sessionId,
    directory,
    ...(workspace ? { workspace } : {}),
    ...(input.reference.harness && isHarnessId(input.reference.harness) ? { harness: { id: input.reference.harness } } : {}),
  })
  if (!sessionRef) throw new Error("Session project is unavailable")

  input.open({
    directory,
    sessionId: input.reference.sessionId,
    title: string(session?.title) ?? "Session",
    sessionRef,
  })
  input.navigate(sessionRoute(input.reference.sessionId))
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function string(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

// Neutral placeholder while non-session surface chunks load — matches the
const HiddenDocumentsSurface = () => <div class="flex size-full items-center justify-center bg-background-base text-text-weak">Documents are not available for this identity.</div>

function DocumentsSurface(props: { canUseDocuments?: boolean; children: JSX.Element }) {
  if (props.canUseDocuments === false) return <HiddenDocumentsSurface />
  return props.children
}

/**
 * Every hosted content surface, registered as one set.
 *
 * Contribution IDs and surface names are unchanged from when these lived in the
 * local list. Persisted workbench state references surfaces by those strings,
 * so renaming one would orphan every restored tab pointing at it.
 */
export const hostedContentSurfaces: ContentSurfaceContribution[] = [
  {
    id: "surface.content.page",
    tier: "claxedo-first-party",
    surface: "page",
    slot: "workbench",
    renderer: (context) => (
      <DocumentsSurface canUseDocuments={context.canUseDocuments}>
        <Suspense fallback={<SurfaceFallback />}>
          <PageContent meta={context.meta} ctx={context.ctx} />
        </Suspense>
      </DocumentsSurface>
    ),
  },
  {
    id: "surface.content.pages-index",
    tier: "claxedo-first-party",
    surface: "pages-index",
    slot: "workbench",
    renderer: (context) => (
      <DocumentsSurface canUseDocuments={context.canUseDocuments}>
        <Suspense fallback={<SurfaceFallback />}>
          <PagesIndexContent meta={context.meta} ctx={context.ctx} />
        </Suspense>
      </DocumentsSurface>
    ),
  },
  {
    id: "surface.content.workgraph",
    tier: "claxedo-first-party",
    surface: "workgraph",
    slot: "workbench",
    renderer: (context) => <WorkGraphSurface context={context} />,
  },
  {
    id: "surface.content.workgraph.workspace",
    tier: "claxedo-first-party",
    surface: "workspace-workgraph",
    slot: "workbench",
    renderer: (context) => <WorkspaceWorkGraphSurface context={context} />,
  },
  {
    id: "surface.content.task-composer",
    tier: "claxedo-first-party",
    surface: "task-composer",
    slot: "workbench",
    renderer: (context) => <TaskComposerSurface context={context} />,
  },
]
