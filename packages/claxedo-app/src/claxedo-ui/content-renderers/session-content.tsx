import { Show, Suspense, lazy } from "solid-js"
import type { ContentMeta } from "../state"
import { useClaxedoState } from "../state"
import type { PaneCtx } from "../layout"
import { DirectoryScope } from "../components/directory-scope"
import { SessionParamsProvider } from "../context/session-params"
import { PaneIdProvider } from "../context/pane-id"

const SessionPage = lazy(() => import("../../overrides/pages/session"))

export function SessionContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const state = useClaxedoState()
  const directory = () => props.meta.directory
  const sessionId = () => props.meta.sessionId
  return (
    <Show
      when={directory()}
      fallback={<div class="flex items-center justify-center h-full text-text-weak">Missing workspace</div>}
    >
      {(dir) => (
        <SessionParamsProvider
          sessionId={() => sessionId()}
          directory={() => dir()}
          paneId={() => props.ctx.paneId}
          surfaceId={() => props.meta.id}
          leafId={() => props.meta.id}
        >
          <PaneIdProvider paneId={props.ctx.paneId}>
            <DirectoryScope
              directory={dir()}
              onNavigateToSession={(nextSessionId) => state.layout.openSession(dir(), nextSessionId, "Session")}
            >
              <Suspense fallback={<div class="flex items-center justify-center h-full text-text-weak">Loading...</div>}>
                <SessionPage />
              </Suspense>
            </DirectoryScope>
          </PaneIdProvider>
        </SessionParamsProvider>
      )}
    </Show>
  )
}
