import { Show } from "solid-js"
import type { ContentMeta } from "../state"
import { useClaxedoState } from "../state"
import type { PaneCtx } from "../layout"
import { DirectoryScope } from "../components/directory-scope"
import { TabPage } from "../components/tab-page"
import { PaneIdProvider } from "../context/pane-id"

export function PageContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const state = useClaxedoState()
  const backToIndex = () => state.layout.openPagesIndex(props.meta.directory)
  return (
    <Show
      when={props.meta.directory}
      fallback={
        <TabPage
          pageId={props.meta.pageId!}
          directory={props.meta.directory}
          filePath={props.meta.filePath}
          leafId={props.meta.id}
          surfaceId={props.meta.id}
          onBackToIndex={backToIndex}
        />
      }
    >
      {(directory) => (
        <PaneIdProvider paneId={props.ctx.paneId}>
          <DirectoryScope
            directory={directory()}
            onNavigateToSession={(sessionId) => state.layout.openSession(directory(), sessionId, "Session")}
          >
            <TabPage
              pageId={props.meta.pageId!}
              sessionId={props.meta.sessionId}
              directory={directory()}
              filePath={props.meta.filePath}
              leafId={props.meta.id}
              surfaceId={props.meta.id}
              onBackToIndex={backToIndex}
            />
          </DirectoryScope>
        </PaneIdProvider>
      )}
    </Show>
  )
}
