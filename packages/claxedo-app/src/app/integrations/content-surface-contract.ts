import type { JSX } from "@solidjs/web"
import type { PaneCtx } from "../workbench/workbench/index"
import type { ContentMeta, ContentType } from "../workbench/state/index"
import type { SurfaceContribution } from "./registry"

/**
 * The shape a content surface renders against.
 *
 * Type-only, and its own module so the hosted surface set can depend on the
 * contract without importing the local surface list — types are erased, so this
 * edge costs nothing at runtime and the two sets stay in separate closures.
 */
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
