import { Show } from "solid-js"
import type { ContentMeta } from "../../../../app/workbench/state/index"
import { SessionPaneScope, useClaxedoState } from "@/features/documents/app-ports"
import type { PaneCtx } from "../../../../app/workbench/workbench/index"
import { TabPage } from "../../editor/document-tab"
import { retargetSessionRef } from "@/platform/identity/session-ref"

export function PageContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const state = useClaxedoState()
  const backToIndex = () => state.layout.openPagesIndex(props.meta.directory)
  const sessionRef = () => props.meta.content?.sessionRef
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
        <SessionPaneScope
          directory={directory()}
          sessionRef={sessionRef}
          active={props.ctx.isVisible}
          sessionId={() => props.meta.sessionId}
          paneId={() => props.ctx.paneId}
          surfaceId={() => props.meta.id}
          leafId={() => props.meta.id}
          onNavigateToSession={(sessionId) =>
            state.layout.openSession(directory(), sessionId, "Session", {
              sessionRef: retargetSessionRef({
                sessionId,
                source: sessionRef(),
              }),
            })}
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
        </SessionPaneScope>
      )}
    </Show>
  )
}
