import type { JSX } from "solid-js"
import type { PaneCtx } from "../workbench/workbench/index"
import type { ContentMeta } from "../workbench/state/index"
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

/**
 * The id of a renderable content surface: a first-party `ContentType`, or one
 * contributed by a product or plugin.
 *
 * `string`, not `ContentType | string` — that union collapses to `string`, so
 * it only read as a union. The first-party ids stay enumerated in `ContentType`.
 */
export type ContentSurfaceId = string

export type ContentSurfaceContribution = SurfaceContribution<ContentSurfaceRenderContext, never> & {
  surface: ContentSurfaceId
  renderer: (context: ContentSurfaceRenderContext) => JSX.Element
  /**
   * Whether the pane holding this surface offers its drag grip. Defaults to
   * true; a surface the user reaches as a whole page rather than as one of
   * several panes sets it false and the grip is not rendered at all.
   */
  draggablePane?: boolean
}
