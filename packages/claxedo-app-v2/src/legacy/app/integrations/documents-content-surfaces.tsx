import { lazy, type JSX, Suspense } from "solid-js"

import type { ContentSurfaceContribution } from "./content-surface-contract"
import { SurfaceFallback } from "./surface-fallback"

const PageContent = lazy(() =>
  import("../../features/documents/ui/content/page-content").then((module) => ({ default: module.PageContent })),
)
const PagesIndexContent = lazy(() =>
  import("../../features/documents/ui/content/pages-index-content").then((module) => ({ default: module.PagesIndexContent })),
)

const HiddenDocumentsSurface = () => (
  <div class="flex size-full items-center justify-center bg-background-base text-text-weak">
    Documents are not available for this identity.
  </div>
)

function DocumentsSurface(props: { canUseDocuments?: boolean; children: JSX.Element }) {
  if (props.canUseDocuments === false) return <HiddenDocumentsSurface />
  return props.children
}

export const documentsContentSurfaces: ContentSurfaceContribution[] = [
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
]
