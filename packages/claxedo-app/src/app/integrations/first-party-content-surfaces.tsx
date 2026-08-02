import { For, type JSX, lazy, Show, Suspense } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { PaneCtx } from "../workbench/workbench/index"
import type { ContentMeta, ContentType } from "../workbench/state/index"
import { SessionContent } from "../../features/session/ui/content/session-content"
import { createContributionRegistry, type ContributionGateContext, type SurfaceContribution } from "./registry"
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

// Lazy content surfaces: keep non-session feature bundles out of the eager main
// chunk. SessionContent stays eager so runner/model async work inside the
// composer cannot bubble to a top-level Suspense fallback and blank the pane.
const TerminalContent = lazy(() => import("../../features/terminal/ui/content/terminal-content").then((m) => ({ default: m.TerminalContent })))
const PageContent = lazy(() => import("../../features/documents/ui/content/page-content").then((m) => ({ default: m.PageContent })))
const ContextContent = lazy(() => import("../workbench/content/context-content").then((m) => ({ default: m.ContextContent })))
const PagesIndexContent = lazy(() => import("../../features/documents/ui/content/pages-index-content").then((m) => ({ default: m.PagesIndexContent })))
const MarketplaceContent = lazy(() => import("@/features/extensions/marketplace").then((m) => ({ default: m.MarketplaceContent })))
function MarketplaceSurface(props: { context: ContentSurfaceRenderContext }) {
  const platform = usePlatform()
  return <MarketplaceContent directory={props.context.meta.directory} request={platform.fetch} />
}

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

function TaskComposerSurface(props: { context: ContentSurfaceRenderContext }) {
  const platform = usePlatform()
  const state = useClaxedoState()
  const navigate = useNavigate()
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const retarget = (nextDirectory: string) => {
    state.meta.patch(props.context.meta.id, {
      directory: nextDirectory,
      scope: "directory",
      content: { type: "task-composer", directory: nextDirectory, title: "New task" },
    })
    navigate(newTaskRoute(nextDirectory), { replace: true })
  }
  return (
    <Show
      keyed
      when={props.context.meta.directory}
      fallback={
        <main class="flex size-full items-center justify-center bg-background-base p-6" aria-label="Choose a project for the task">
          <section class="w-full max-w-md rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-sm">
            <h1 class="text-[14px] font-medium text-text-base">Where should this task live?</h1>
            <p class="mt-1 text-[12px] text-text-weaker">Choose a project before composing the task.</p>
            <div class="mt-3 space-y-1">
              <For each={projectsQuery.data ?? []}>
                {(project) => (
                  <button
                    type="button"
                    class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-[12px] text-text-base hover:bg-surface-base-hover"
                    onClick={() => retarget(project.worktree)}
                  >
                    <span class="truncate">{project.name?.trim() || project.worktree.split("/").filter(Boolean).at(-1)}</span>
                    <span class="ml-3 truncate text-[11px] text-text-weaker">{project.worktree}</span>
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
// workbench background so there is no flash before the panel paints.
const SurfaceFallback = (props: { label?: string }) => (
  <div role="status" aria-label={props.label ?? "Loading content"} class="flex size-full items-center justify-center gap-3 bg-background-base text-14-regular text-text-weak">
    <span class="size-4 animate-spin rounded-full border border-border-base border-t-transparent" aria-hidden="true" />
    <span>{props.label ?? "Loading…"}</span>
  </div>
)
const HiddenDocumentsSurface = () => <div class="flex size-full items-center justify-center bg-background-base text-text-weak">Documents are not available for this identity.</div>

function DocumentsSurface(props: { canUseDocuments?: boolean; children: JSX.Element }) {
  if (props.canUseDocuments === false) return <HiddenDocumentsSurface />
  return props.children
}

export type ContentSurfaceRenderContext = {
  meta: ContentMeta
  ctx: PaneCtx
  fallbackDirectory?: () => string | undefined
  canUseDocuments?: boolean
}

export type ContentSurfaceContribution = SurfaceContribution<ContentSurfaceRenderContext, never> & {
  surface: ContentType | string
  renderer: (context: ContentSurfaceRenderContext) => JSX.Element
}

export const firstPartyContentSurfaces: ContentSurfaceContribution[] = [
  {
    id: "surface.content.session",
    tier: "claxedo-first-party",
    surface: "session",
    slot: "workbench",
    renderer: (context) => <SessionContent meta={context.meta} ctx={context.ctx} fallbackDirectory={context.fallbackDirectory} />,
  },
  {
    id: "surface.content.terminal",
    tier: "claxedo-first-party",
    surface: "terminal",
    slot: "workbench",
    renderer: (context) => (
      <Suspense fallback={<SurfaceFallback />}>
        <TerminalContent meta={context.meta} ctx={context.ctx} />
      </Suspense>
    ),
  },
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
    id: "surface.content.draft-session",
    tier: "claxedo-first-party",
    surface: "draft-session",
    slot: "workbench",
    renderer: (context) => <SessionContent meta={draftSessionMeta(context.meta)} ctx={context.ctx} fallbackDirectory={context.fallbackDirectory} />,
  },
  {
    id: "surface.content.context",
    tier: "claxedo-first-party",
    surface: "context",
    slot: "workbench",
    renderer: (context) => (
      <Suspense fallback={<SurfaceFallback />}>
        <ContextContent meta={context.meta} ctx={context.ctx} />
      </Suspense>
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
    id: "surface.content.marketplace",
    tier: "claxedo-first-party",
    surface: "marketplace",
    slot: "workbench",
    renderer: (context) => (
      <Suspense fallback={<SurfaceFallback />}>
        <MarketplaceSurface context={context} />
      </Suspense>
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

export function createContentSurfaceRegistry(surfaces: ContentSurfaceContribution[] = firstPartyContentSurfaces) {
  return createContributionRegistry({ surfaces: surfaces as SurfaceContribution[] })
}

export const contentSurfaceRegistry = createContentSurfaceRegistry()

export function registerContentSurface(surface: ContentSurfaceContribution) {
  contentSurfaceRegistry.addSurface(surface as SurfaceContribution)
}

export function contentSurface(type: string | undefined, context: ContributionGateContext = {}, registry = contentSurfaceRegistry) {
  return (registry.visibleSurfaces(context) as ContentSurfaceContribution[]).find(
    (surface): surface is ContentSurfaceContribution => surface.surface === type && typeof surface.renderer === "function",
  )
}

function draftSessionMeta(meta: ContentMeta): ContentMeta {
  const directory = meta.directory ?? meta.providerDirectory
  return {
    ...meta,
    type: "session",
    scope: "directory",
    directory,
    sessionId: "new",
    ...(directory
      ? {
          content: {
            type: "session",
            directory,
            sessionId: "new",
            title: meta.content?.title ?? "New Session",
          },
        }
      : {}),
  }
}
