import { Show } from "solid-js"
import type { ContentMeta } from "../state"
import type { PaneCtx } from "../layout"
import { DirectoryScope } from "../components/directory-scope"
import { TabContext } from "../components/tab-context"
import { SessionParamsProvider } from "../context/session-params"
import { PaneIdProvider } from "../context/pane-id"

export function ContextContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  return (
    <Show
      when={props.meta.directory}
      fallback={<div class="flex items-center justify-center h-full text-text-weak">Missing workspace</div>}
    >
      {(dir) => (
        <SessionParamsProvider
          sessionId={() => props.meta.sessionId}
          directory={() => dir()}
          paneId={() => props.ctx.paneId}
          surfaceId={() => props.meta.id}
          leafId={() => props.meta.id}
        >
          <PaneIdProvider paneId={props.ctx.paneId}>
            <DirectoryScope directory={dir()}>
              <TabContext sessionId={props.meta.sessionId!} />
            </DirectoryScope>
          </PaneIdProvider>
        </SessionParamsProvider>
      )}
    </Show>
  )
}
