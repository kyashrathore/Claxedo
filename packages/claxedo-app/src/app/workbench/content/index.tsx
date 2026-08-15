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
        // `Show` invokes this block UNTRACKED and only when `when` flips
        // truthiness, so resolving the surface inline froze the answer for the
        // life of the mount: hosted activation arrived too late to replace
        // "Unknown content type", and sign-out could not take a mounted hosted
        // surface back off. The lookup therefore gets its own memo, which
        // tracks the contribution registry's revision.
        const surface = createMemo(() => {
          const current = m()
          return contentSurface(current.type, { sessionRef: current.content?.sessionRef })
        })
        return (
          <Show
            when={surface()}
            // Keyed: a different contribution for the same type is a different
            // renderer and must re-mount. The memo is stable across metadata
            // patches, so this does not churn long-lived per-content state.
            keyed
            fallback={
              <div class="flex items-center justify-center h-full text-text-weak">
                Unknown content type: {String(type())}
              </div>
            }
          >
            {(resolved) =>
              resolved.renderer({
                // Getters, not eager reads: reading `m()` (or `principal()`)
                // synchronously here subscribes THIS render scope, so every
                // metadata patch — including a plain title update landing from
                // auto-title or the directory-session cache — re-ran the
                // renderer and REMOUNTED the whole surface. For a session pane
                // that teardown detached the sticky header, dropped composer
                // focus to <body> (closing an open slash popover mid-typing),
                // and rebuilt every timeline row. Surface components that need
                // live metadata already re-derive it reactively from the store
                // by id (e.g. `SessionContent`'s own `state.meta.get(...)`
                // memo); the getter keeps `context.meta` current for lazy
                // readers without coupling their lifetime to patch frequency.
                get meta() {
                  return m()
                },
                ctx: props.ctx,
                fallbackDirectory: props.fallbackDirectory,
                get canUseDocuments() {
                  return documentsAccess({ principal: principal(), serverUrl: server.url })
                },
              })
            }
          </Show>
        )
      }}
    </Show>
  )
}

export type { ContentRendererProps as Props }
