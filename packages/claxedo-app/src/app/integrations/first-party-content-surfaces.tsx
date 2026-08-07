import { type JSX, lazy, Suspense } from "solid-js"
import { SessionContent } from "../../features/session/ui/content/session-content"
import { createContributionRegistry, type ContributionGateContext, type SurfaceContribution } from "./registry"
import { usePlatform } from "@/platform/runtime/platform-provider"
import type { ContentMeta } from "../workbench/state/index"
import { SurfaceFallback } from "./surface-fallback"
import type { ContentSurfaceContribution, ContentSurfaceRenderContext } from "./content-surface-contract"

export type { ContentSurfaceContribution, ContentSurfaceRenderContext } from "./content-surface-contract"

/**
 * LOCAL content surfaces.
 *
 * Sessions, terminals, drafts, context, and the marketplace — everything the
 * unsigned desktop renders. WorkGraph and Documents used to live here too,
 * which made `@claxedo/workgraph` a static import of the app's only entry.
 * They now live in `hosted-content-surfaces.tsx` and reach the registry through
 * `app/composition/product-contributions.ts` after an account adapter reports
 * signed state.
 *
 * A surface added here is available to every build, signed or not. That is the
 * decision this file's boundary now forces someone to make explicitly.
 */

// Lazy content surfaces: keep non-session feature bundles out of the eager main
// chunk. SessionContent stays eager so runner/model async work inside the
// composer cannot bubble to a top-level Suspense fallback and blank the pane.
const TerminalContent = lazy(() => import("../../features/terminal/ui/content/terminal-content").then((m) => ({ default: m.TerminalContent })))
const ContextContent = lazy(() => import("../workbench/content/context-content").then((m) => ({ default: m.ContextContent })))
const MarketplaceContent = lazy(() => import("@/features/extensions/marketplace").then((m) => ({ default: m.MarketplaceContent })))
function MarketplaceSurface(props: { context: ContentSurfaceRenderContext }) {
  const platform = usePlatform()
  return <MarketplaceContent directory={props.context.meta.directory} request={platform.fetch} />
}

export const localContentSurfaces: ContentSurfaceContribution[] = [
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
]

export function createContentSurfaceRegistry(surfaces: ContentSurfaceContribution[] = localContentSurfaces) {
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
