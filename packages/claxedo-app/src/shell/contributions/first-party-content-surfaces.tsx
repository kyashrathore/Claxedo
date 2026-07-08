import { type JSX, lazy, Suspense } from "solid-js"
import type { PaneCtx } from "../../claxedo-ui/layout"
import type { ContentMeta, ContentType } from "../../claxedo-ui/state"
import { SessionContent } from "../../claxedo-ui/content-renderers/session-content"
import { createContributionRegistry, type ContributionGateContext, type SurfaceContribution } from "./registry"

// Lazy content surfaces: keep non-session feature bundles out of the eager main
// chunk. SessionContent stays eager so runner/model async work inside the
// composer cannot bubble to a top-level Suspense fallback and blank the pane.
const TerminalContent = lazy(() =>
  import("../../claxedo-ui/content-renderers/terminal-content").then((m) => ({ default: m.TerminalContent })),
)
const PageContent = lazy(() =>
  import("../../claxedo-ui/content-renderers/page-content").then((m) => ({ default: m.PageContent })),
)
const ContextContent = lazy(() =>
  import("../../claxedo-ui/content-renderers/context-content").then((m) => ({ default: m.ContextContent })),
)
const PagesIndexContent = lazy(() =>
  import("../../claxedo-ui/content-renderers/pages-index-content").then((m) => ({ default: m.PagesIndexContent })),
)
const MarketplaceContent = lazy(() =>
  import("../../claxedo-ui/content-renderers/marketplace-content").then((m) => ({ default: m.MarketplaceContent })),
)

// Neutral placeholder while non-session surface chunks load — matches the
// workbench background so there is no flash before the panel paints.
const SurfaceFallback = () => <div class="size-full bg-background-base" />
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
    renderer: () => (
      <Suspense fallback={<SurfaceFallback />}>
        <MarketplaceContent />
      </Suspense>
    ),
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
