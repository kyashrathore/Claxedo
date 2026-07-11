import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { ContentMeta } from "../state"
import { useClaxedoState } from "../state"
import type { PaneCtx } from "../workbench"
import { SessionPaneScope } from "../components/session-pane-scope"
import SessionPage from "../../pages/session"
import { hasBacking, localSessionRefForDirectory, retargetSessionRef } from "../../shell/identity/session-ref"
import { SessionLoadingSurface } from "./session-loading-surface"

export function SessionContent(props: { meta: ContentMeta; ctx: PaneCtx; fallbackDirectory?: () => string | undefined }) {
  const state = useClaxedoState()
  const meta = createMemo(() => {
    state.meta.ids()
    return state.meta.get(props.meta.id) ?? props.meta
  })
  const directory = () => meta().directory
  const sessionId = () => meta().sessionId
  const sessionRef = () => {
    const content = meta().content
    return content?.type === "session" ? content.sessionRef : undefined
  }
  const effectiveSessionRef = () => sessionRef() ?? localSessionRefForDirectory({
    sessionId: sessionId(),
    directory: directory(),
  })
  const requiresSessionRef = () => !!sessionId() && sessionId() !== "new"
  const missingSessionRef = () => requiresSessionRef() && !effectiveSessionRef() && !directory()
  const sessionVisible = () => typeof props.ctx.isVisible === "function" ? props.ctx.isVisible() : !!props.ctx.isVisible
  const [activated, setActivated] = createSignal(false)
  createEffect(() => {
    if (activated() || !sessionVisible()) return
    setActivated(true)
  })
  const shouldRenderSession = () => sessionVisible() || activated()
  const activeForHydration = () => sessionVisible()
  const stashedSession = () => (
    <div
      class="size-full"
      data-testid="session-content-stashed"
      data-session-id={sessionId() ?? ""}
      data-session-directory={directory() ?? ""}
    />
  )
  const sessionPage = () => <SessionPage />
  const canRenderWorkspaceScope = () => {
    const ref = effectiveSessionRef()
    if (!requiresSessionRef()) return true
    if (!ref) return !!directory()
    return hasBacking(ref)
  }
  const fallbackDirectory = createMemo(() => {
    const dir = directory() ?? props.fallbackDirectory?.()
    return dir && dir !== "/workspace" ? dir : undefined
  })
  const [centralFallbackExpired, setCentralFallbackExpired] = createSignal(false)
  createEffect(() => {
    const waitingForRealSession = requiresSessionRef() && !effectiveSessionRef() && !!fallbackDirectory()
    setCentralFallbackExpired(false)
    if (!waitingForRealSession) return
    const timer = setTimeout(() => setCentralFallbackExpired(true), 1_200)
    onCleanup(() => clearTimeout(timer))
  })
  const realSessionLoading = () => (
    <SessionLoadingSurface
      meta={meta()}
      sessionId={sessionId()}
      directory={directory() ?? fallbackDirectory()}
    />
  )
  const noWorkspaceBacking = () => (
    <div
      class="flex h-full items-center justify-center text-text-weak"
      data-testid="central-session-content"
      data-session-id={sessionId() ?? ""}
    >
      {requiresSessionRef() ? "Session unavailable" : "No workspace backing"}
    </div>
  )
  const centralSessionFallback = () =>
    fallbackDirectory() && !centralFallbackExpired() ? realSessionLoading() : noWorkspaceBacking()
  const fallbackDraftComposer = () => (
    <Show when={!sessionId() || sessionId() === "new"} fallback={centralSessionFallback()}>
      <Show
        when={fallbackDirectory()}
        fallback={noWorkspaceBacking()}
      >
        {(dir) => (
          <SessionPaneScope
            directory={dir()}
            active={activeForHydration}
            sessionId={() => "new"}
            paneId={() => props.ctx.paneId}
            surfaceId={() => meta().id}
          leafId={() => meta().id}
        >
          <div
            class="size-full"
            data-testid="session-content-fallback-draft"
            data-session-id="new"
            data-session-directory={dir()}
            data-recovered-from-session-id={sessionId() ?? ""}
          >
            {sessionPage()}
          </div>
        </SessionPaneScope>
      )}
      </Show>
    </Show>
  )
  return (
    <Show when={shouldRenderSession()} fallback={stashedSession()}>
        <Show
          when={!missingSessionRef()}
          fallback={<div class="flex items-center justify-center h-full text-text-weak">Missing session identity</div>}
        >
          <Show
            when={canRenderWorkspaceScope() ? directory() : undefined}
            fallback={
              <Show
                when={effectiveSessionRef()?.host === "central"}
                fallback={<div class="flex items-center justify-center h-full text-text-weak">Missing workspace</div>}
              >
                {fallbackDraftComposer()}
              </Show>
            }
          >
            {(dir) => (
              <SessionPaneScope
                directory={dir()}
                sessionRef={effectiveSessionRef}
                active={activeForHydration}
                sessionId={() => sessionId()}
                paneId={() => props.ctx.paneId}
                surfaceId={() => meta().id}
                leafId={() => meta().id}
                connectionFallback={requiresSessionRef() ? realSessionLoading() : undefined}
                onNavigateToSession={(nextSessionId) =>
                  state.layout.openSession(dir(), nextSessionId, "Session", {
                    sessionRef: retargetSessionRef({
                      sessionId: nextSessionId,
                      source: effectiveSessionRef(),
                    }),
                  })}
              >
                <div
                  class="size-full"
                  data-testid="session-content"
                  data-content-id={meta().id}
                  data-session-id={sessionId() ?? ""}
                  data-session-directory={dir()}
                >
                  {sessionPage()}
                </div>
              </SessionPaneScope>
            )}
          </Show>
        </Show>
    </Show>
  )
}
