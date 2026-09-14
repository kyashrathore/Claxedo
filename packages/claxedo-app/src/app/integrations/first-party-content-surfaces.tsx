import { lazy, Suspense } from "solid-js"
import { SessionContent } from "../../features/session/ui/content/session-content"
import { createContributionRegistry, type ContributionGateContext } from "./registry"
import type { ContentMeta } from "../workbench/state/index"
import { SurfaceFallback } from "./surface-fallback"
import type { ContentSurfaceContribution, ContentSurfaceRenderContext } from "./content-surface-contract"

export type { ContentSurfaceContribution, ContentSurfaceRenderContext } from "./content-surface-contract"

/**
 * LOCAL content surfaces.
 *
 * Sessions, terminals, drafts, and context — everything the unsigned desktop
 * renders. Documents lives in `documents-content-surfaces.tsx` instead,
 * reached through `app/composition/product-contributions.ts` after an account
 * adapter reports signed state — registering it as a static import here would
 * put it in the app's only entry. Agent Plugins contributes `marketplace` the
 * same way, from `app/composition/agent-plugin-contribution-loader.tsx`.
 *
 * A surface added here is available to every build, signed or not — that is
 * the decision this file's boundary forces explicitly.
 */

// Lazy content surfaces: keep non-session feature bundles out of the eager main
// chunk. SessionContent stays eager so runner/model async work inside the
// composer cannot bubble to a top-level Suspense fallback and blank the pane.
const TerminalContent = lazy(() => import("../../features/terminal/ui/content/terminal-content").then((m) => ({ default: m.TerminalContent })))
const ContextContent = lazy(() => import("../workbench/content/context-content").then((m) => ({ default: m.ContextContent })))

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
]

export function createContentSurfaceRegistry(surfaces: ContentSurfaceContribution[] = localContentSurfaces) {
  return createContributionRegistry({ surfaces })
}

export const contentSurfaceRegistry = createContentSurfaceRegistry()

export function registerContentSurface(surface: ContentSurfaceContribution) {
  contentSurfaceRegistry.addSurface(surface)
}

/**
 * Removes a surface registered by an activation.
 *
 * Takes the contribution rather than its id so the two halves have the same
 * signature at the composition seam, and so a caller cannot un-register
 * something it never held a reference to.
 */
export function unregisterContentSurface(surface: ContentSurfaceContribution) {
  contentSurfaceRegistry.removeSurface(surface.id)
}

export function contentSurface(type: string | undefined, context: ContributionGateContext = {}, registry = contentSurfaceRegistry) {
  return registry.visibleSurfaces(context).find(
    (surface): surface is ContentSurfaceContribution => surface.surface === type && typeof surface.renderer === "function",
  )
}

/** A content type nothing has contributed keeps the grip, which is the shell's own default. */
export function contentSurfacePaneDraggable(type: string | undefined, registry = contentSurfaceRegistry) {
  return contentSurface(type, {}, registry)?.draggablePane !== false
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
