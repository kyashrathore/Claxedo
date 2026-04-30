// ContentRenderer — dispatches on `meta.type` and renders the matching
// per-type workspace panel wrapper.

import { Show, type JSX } from "solid-js"
import type { PaneCtx } from "../layout"
import { useClaxedoState } from "../state"
import { SessionContent } from "./session-content"
import { TerminalContent } from "./terminal-content"
import { PageContent } from "./page-content"
import { DraftSessionContent } from "./draft-session-content"
import { ContextContent } from "./context-content"
import { PagesIndexContent } from "./pages-index-content"
import { WorkgraphContent } from "./workgraph-content"

export type ContentRendererProps = {
  id: string
  ctx: PaneCtx
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
  const meta = () => state.meta.get(props.id)
  const type = () => meta()?.type
  return (
    <Show when={meta()} keyed>
      {(m) => {
        switch (m.type) {
          case "session":
            return <SessionContent meta={m} ctx={props.ctx} />
          case "terminal":
            return <TerminalContent meta={m} ctx={props.ctx} />
          case "page":
            return <PageContent meta={m} ctx={props.ctx} />
          case "draft-session":
            return <DraftSessionContent meta={m} ctx={props.ctx} />
          case "context":
            return <ContextContent meta={m} ctx={props.ctx} />
          case "pages-index":
            return <PagesIndexContent meta={m} ctx={props.ctx} />
          case "workgraph":
            return <WorkgraphContent meta={m} ctx={props.ctx} />
          default:
            return (
              <div class="flex items-center justify-center h-full text-text-weak">
                Unknown content type: {String(type())}
              </div>
            )
        }
      }}
    </Show>
  )
}

export type { ContentRendererProps as Props }
