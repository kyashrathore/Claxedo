// ContentRenderer — dispatches on `meta.type` and renders the matching
// per-type workspace panel wrapper.

import { Show, createMemo, type JSX } from "solid-js"
import type { PaneCtx } from "../workbench/index"
import { useClaxedoState } from "../state/index"
import { contentSurface } from "../../integrations/first-party-content-surfaces"
import { usePrincipal } from "@/platform/auth/identity-provider"
import { documentsAccess } from "@/features/documents/access"
import { useServer } from "@claxedo/app"

export type ContentRendererProps = {
  id: string
  ctx: PaneCtx
  fallbackDirectory?: () => string | undefined
}

/**
 * ContentRenderer — top-level dispatch.
 *
 * Reactive: when `state.meta.get(id)` changes (e.g. a content's identity is
 * patched), the matching renderer re-mounts. Long-lived per-content state
 * (e.g. xterm scrollback) lives in the wrapped component — keep those wrappers
 * stable across rerenders.
 */
export function ContentRenderer(props: ContentRendererProps): JSX.Element {
  const state = useClaxedoState()
  const principal = usePrincipal()
  const server = useServer()
  const meta = createMemo(() => {
    state.meta.ids()
    return state.meta.get(props.id)
  })
  const type = () => meta()?.type
  return (
    <Show
      when={meta()}
      fallback={
        <div
          data-testid="content-metadata-loading"
          class="flex h-full w-full items-center justify-center bg-background-base text-text-weak"
        >
          <div class="flex items-center gap-3 text-16-medium">
            <div class="size-5 animate-spin rounded-full border border-border-base border-t-transparent" />
            <span>Preparing workspace</span>
          </div>
        </div>
      }
    >
      {(m) => {
        const current = m()
        const surface = contentSurface(current.type, { sessionRef: current.content?.sessionRef })
        if (surface) {
          return surface.renderer({
            meta: current,
            ctx: props.ctx,
            fallbackDirectory: props.fallbackDirectory,
            canUseDocuments: documentsAccess({ principal: principal(), serverUrl: server.url }),
          })
        }
        return (
          <div class="flex items-center justify-center h-full text-text-weak">
            Unknown content type: {String(type())}
          </div>
        )
      }}
    </Show>
  )
}

export type { ContentRendererProps as Props }
