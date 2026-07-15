import { type JSX, lazy, Suspense } from "solid-js"
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
import { sessionRoute } from "@/platform/identity/route"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { workGraphExecutionContext } from "./workgraph-execution-context"
import { DialogSelectDirectory } from "@/app/dialogs/select-directory"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useServer } from "@/app/connection/server"
import { ensureLocalProject } from "@/features/workspaces/data/query/project-ensure"
import { WorkGraphContent } from "../../features/workgraph"
import type { WorkGraphSessionReference } from "@/features/workgraph/api"
import { bypassFetchThrottle } from "@/lib/fetch-throttle"
import { isHarnessId, sessionRefForWorkspaceSession, type SessionRef } from "@/platform/identity/session-ref"
import {
  routeBridgeClaxedoSessionMetaUrl,
  routeSessionWorkspaceBacking,
} from "@/app/workbench/state/route-bridge-resolution"
import { sessionInventoryTarget, type RouteIntentInventory } from "@/app/workbench/state/route-intent"
import { sessionInventoryQueryOptions } from "@/features/session/data/sync/queries"
import type { SessionInventoryRow } from "@/features/session/data/query/types"

// Lazy content surfaces: keep non-session feature bundles out of the eager main
// chunk. SessionContent stays eager so runner/model async work inside the
// composer cannot bubble to a top-level Suspense fallback and blank the pane.
const TerminalContent = lazy(() =>
  import("../../features/terminal/ui/content/terminal-content").then((m) => ({ default: m.TerminalContent })),
)
const PageContent = lazy(() =>
  import("../../features/documents/ui/content/page-content").then((m) => ({ default: m.PageContent })),
)
const ContextContent = lazy(() =>
  import("../workbench/content/context-content").then((m) => ({ default: m.ContextContent })),
)
const PagesIndexContent = lazy(() =>
  import("../../features/documents/ui/content/pages-index-content").then((m) => ({ default: m.PagesIndexContent })),
)
const MarketplaceContent = lazy(() =>
  import("@/features/extensions/marketplace").then((m) => ({ default: m.MarketplaceContent })),
)
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

function WorkGraphSurface(props: { context: ContentSurfaceRenderContext }) {
  const platform = usePlatform()
  const state = useClaxedoState()
  const navigate = useNavigate()
  const queryOptions = useQueryOptions()
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const dialog = useDialog()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({ baseUrl: globalSDK.url }),
  )
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
      return mode === "workgraph-settings" ? ("settings" as const) : ("attention" as const)
    },
    isOpen: () => panelState().open,
    identity: panelState,
    open: (view: "attention" | "settings") =>
      state.workspacePanel.openGlobal(view === "settings" ? "workgraph-settings" : "workgraph-attention"),
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
  const localProjects = () => (projectsQuery.data ?? [])
    .filter((project) => workGraphExecutionContext(project.worktree, [project])?.kind === "local_worktree")
    .map((project) => ({ value: project.worktree, label: project.worktree }))
  const chooseLocalProject = async () => {
    const result = platform.openDirectoryPickerDialog && server.isLocal()
      ? await platform.openDirectoryPickerDialog({ title: "Choose project", multiple: false })
      : await new Promise<string | string[] | null>((resolve) => {
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
    return directory
  }
  const openSession = (reference: WorkGraphSessionReference) => openWorkGraphSession({
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
    />
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
  const inventoryTarget = input.inventory
    ? sessionInventoryTarget(input.reference.sessionId, input.inventory)
    : undefined
  if (inventoryTarget?.sessionRef) {
    input.open({
      directory: inventoryTarget.directory,
      sessionId: input.reference.sessionId,
      title: inventoryTarget.title ?? "Session",
      sessionRef: input.reference.harness && isHarnessId(input.reference.harness)
        ? { ...inventoryTarget.sessionRef, harness: { id: input.reference.harness } }
        : inventoryTarget.sessionRef,
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
  const workspace = catalogWorkspace ?? (
    input.reference.environment?.kind === "hosted_workspace" && workspaceId
      ? { workspaceId, kind: "cloud" as const }
      : undefined
  )
  const sessionRef = sessionRefForWorkspaceSession({
    sessionId: input.reference.sessionId,
    directory,
    ...(workspace ? { workspace } : {}),
    ...(input.reference.harness && isHarnessId(input.reference.harness)
      ? { harness: { id: input.reference.harness } }
      : {}),
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
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function string(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

// Neutral placeholder while non-session surface chunks load — matches the
// workbench background so there is no flash before the panel paints.
const SurfaceFallback = (props: { label?: string }) => (
  <div
    role="status"
    aria-label={props.label ?? "Loading content"}
    class="flex size-full items-center justify-center gap-3 bg-background-base text-14-regular text-text-weak"
  >
    <span class="size-4 animate-spin rounded-full border border-border-base border-t-transparent" aria-hidden="true" />
    <span>{props.label ?? "Loading…"}</span>
  </div>
)
const HiddenPagesSurface = () => (
  <div class="flex size-full items-center justify-center bg-background-base text-text-weak">
    Pages are not available for this identity.
  </div>
)

function PagesSurface(props: { canUsePages?: boolean; children: JSX.Element }) {
  if (props.canUsePages === false) return <HiddenPagesSurface />
  return props.children
}

export type ContentSurfaceRenderContext = {
  meta: ContentMeta
  ctx: PaneCtx
  fallbackDirectory?: () => string | undefined
  canUsePages?: boolean
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
    renderer: (context) => (
      <SessionContent meta={context.meta} ctx={context.ctx} fallbackDirectory={context.fallbackDirectory} />
    ),
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
      <PagesSurface canUsePages={context.canUsePages}>
        <Suspense fallback={<SurfaceFallback />}>
          <PageContent meta={context.meta} ctx={context.ctx} />
        </Suspense>
      </PagesSurface>
    ),
  },
  {
    id: "surface.content.draft-session",
    tier: "claxedo-first-party",
    surface: "draft-session",
    slot: "workbench",
    renderer: (context) => (
      <SessionContent meta={draftSessionMeta(context.meta)} ctx={context.ctx} fallbackDirectory={context.fallbackDirectory} />
    ),
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
      <PagesSurface canUsePages={context.canUsePages}>
        <Suspense fallback={<SurfaceFallback />}>
          <PagesIndexContent meta={context.meta} ctx={context.ctx} />
        </Suspense>
      </PagesSurface>
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
]

export function createContentSurfaceRegistry(surfaces: ContentSurfaceContribution[] = firstPartyContentSurfaces) {
  return createContributionRegistry({ surfaces: surfaces as SurfaceContribution[] })
}

export const contentSurfaceRegistry = createContentSurfaceRegistry()

export function registerContentSurface(surface: ContentSurfaceContribution) {
  contentSurfaceRegistry.addSurface(surface as SurfaceContribution)
}

export function contentSurface(
  type: string | undefined,
  context: ContributionGateContext = {},
  registry = contentSurfaceRegistry,
) {
  return (registry
    .visibleSurfaces(context) as ContentSurfaceContribution[])
    .find((surface): surface is ContentSurfaceContribution =>
      surface.surface === type && typeof surface.renderer === "function"
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
