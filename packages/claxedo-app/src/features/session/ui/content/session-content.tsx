import { Show, createEffect, createMemo, createSignal, lazy, onCleanup } from "solid-js"
import type { ContentMeta } from "@/features/session/app-ports"
import { useClaxedoState } from "@/features/session/app-ports"
import type { PaneCtx } from "@/features/session/app-ports"
import { SessionPaneScope } from "../components/session-pane-scope"
import SessionPage from "@/features/session/ui/session-screen"
import { hasBacking, isDirectorylessPiSession, localSessionRefForDirectory, retargetSessionRef } from "@/platform/identity/session-ref"
import { SessionLoadingSurface } from "./session-loading-surface"

const SessionEnvironmentCardMount = lazy(() =>
  import("./session-environment-card").then((module) => ({
    default: module.SessionEnvironmentCardMount,
  })),
)

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
  /**
   * A draft session has no server-side session behind it yet: the route carries
   * either no id at all or the `"new"` placeholder that stands in until the
   * first prompt creates one.
   *
   * Named because two separate decisions read it — whether a session ref is
   * required, and whether the environment card mounts — and `!!id && id !==
   * "new"` open-coded twice invites the two from drifting apart.
   */
  const draftSession = () => !sessionId() || sessionId() === "new"
  const requiresSessionRef = () => !draftSession()
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
  const paneDirectory = () => {
    const ref = effectiveSessionRef()
    if (ref?.host === "central") {
      const value = directory() ?? fallbackDirectory()
      if (value !== undefined) return { value }
      if (isDirectorylessPiSession({ sessionRef: ref })) return { value: "" }
      return
    }
    if (canRenderWorkspaceScope() && directory() !== undefined) return { value: directory()! }
    return undefined
  }
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
            when={paneDirectory()}
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
                directory={dir().value}
                sessionRef={effectiveSessionRef}
                active={activeForHydration}
                sessionId={() => sessionId()}
                paneId={() => props.ctx.paneId}
                surfaceId={() => meta().id}
                leafId={() => meta().id}
                connectionFallback={requiresSessionRef() ? realSessionLoading() : undefined}
                onNavigateToSession={(nextSessionId) =>
                  state.layout.openSession(dir().value, nextSessionId, "Session", {
                    sessionRef: retargetSessionRef({
                      sessionId: nextSessionId,
                      source: effectiveSessionRef(),
                    }),
                  })}
              >
                <div
                  class="size-full session-envcard-shell"
                  data-testid="session-content"
                  data-content-id={meta().id}
                  data-session-id={sessionId() ?? ""}
                  data-session-directory={dir().value}
                >
                  <div class="session-envcard-primary">{sessionPage()}</div>
                  {/* Not on a draft session. The card reports on a session that
                      exists — isolation, subagents, and a collapsed rail whose
                      items deep-link to that session's Changes, Files and
                      Processes. None of those have a referent before the first
                      prompt creates the session, so on the draft screen it is a
                      card of dead ends that also costs the composer its
                      right-hand gutter.

                      Gating the MOUNT rather than adding a condition inside the
                      card keeps the split clean — whether this surface exists for
                      this route is the pane's concern, while the card owns its own
                      visibility (workspace panel open, pane focus, persisted
                      collapse state) — and it is strictly cheaper: an unmounted
                      card never creates its file-status, vcs or processes queries
                      at all, where an internal flag would leave them mounted and
                      merely disabled. It is also what the CSS expects: the
                      reserved gutter is keyed off `:has(.session-envcard)`, so an
                      unmounted card reclaims the width with no extra rule. */}
                  <Show when={!draftSession()}>
                    <SessionEnvironmentCardMount />
                  </Show>
                </div>
              </SessionPaneScope>
            )}
          </Show>
        </Show>
    </Show>
  )
}
