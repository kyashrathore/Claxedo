import { Show, Suspense, createEffect, createMemo, createSignal, lazy, onCleanup } from "solid-js"
import type { ContentMeta } from "@/features/session/app-ports"
import { useClaxedoState } from "@/features/session/app-ports"
import type { PaneCtx } from "@/features/session/app-ports"
import { SessionPaneScope } from "../components/session-pane-scope"
import SessionPage from "@/features/session/ui/session-screen"
import { hasBacking, isDirectorylessPiSession, localSessionRefForDirectory, retargetSessionRef } from "@/platform/identity/session-ref"
import { getSessionPrefetchPromise } from "@/platform/sync/session-prefetch"
import { SessionLoadingRoot, SessionLoadingSurface } from "./session-loading-surface"
import { createSessionMountSettle } from "./session-mount-settle"
import { markRendererPhase, measureRendererPhase } from "@/platform/performance/renderer-trace"
// Type-only, so the card's lazy chunk stays lazy.
import type { SessionEnvironmentCardOccupancy } from "./session-environment-card"
// The `.session-envcard-shell` / `.session-envcard-primary` layout rules must
// arrive with THIS component: the shell markup below renders unconditionally,
// while the card component that also imports this stylesheet is a lazy chunk
// that may never load (local sessions mount no card). Without the eager import
// the shell has no flex layout and the whole session page collapses to zero
// height — present in the DOM, painted nowhere, clickable never.
import "./session-environment-card.css"

const SessionEnvironmentCardMount = lazy(() =>
  import("./session-environment-card").then((module) => ({
    default: module.SessionEnvironmentCardMount,
  })),
)

export function SessionContent(props: { meta: ContentMeta; ctx: PaneCtx; fallbackDirectory?: () => string | undefined }) {
  const state = useClaxedoState()
  const meta = createMemo(() => state.meta.get(props.meta.id) ?? props.meta)
  // Identity belongs to this retained surface. Keep each projection memoized
  // here instead of handing descendants chains of plain functions that
  // re-resolve the same metadata, local ref, and backing on every prop read.
  // Pane focus changes only `ctx.isVisible`; it must not make the retained
  // session rebuild identity hundreds of times.
  const directory = createMemo(() => meta().directory)
  const sessionId = createMemo(() => meta().sessionId)
  const sessionRef = createMemo(() => {
    const content = meta().content
    return content?.type === "session" ? content.sessionRef : undefined
  })
  const effectiveSessionRef = createMemo(() => sessionRef() ?? localSessionRefForDirectory({
    sessionId: sessionId(),
    directory: directory(),
  }))
  /**
   * A draft session has no server-side session behind it yet: the route carries
   * either no id at all or the `"new"` placeholder that stands in until the
   * first prompt creates one.
   *
   * Named because two separate decisions read it — whether a session ref is
   * required, and whether the environment card mounts — and `!!id && id !==
   * "new"` open-coded twice invites the two from drifting apart.
   */
  const draftSession = createMemo(() => !sessionId() || sessionId() === "new")
  /**
   * How much of the pane's right gutter the environment card is occupying, as
   * reported by the card itself (it owns that policy — see its mount doc).
   * Stamped on the shell as `data-session-envcard` so the reservation rules in
   * session-environment-card.css are plain descendant selectors.
   *
   * Deliberately not `:has(.session-envcard)`: this shell wraps the entire
   * session pane, and a `:has()` here makes it a Blink invalidation anchor whose
   * every re-check sweeps the whole transcript with the document's aggregated
   * `:has` invalidation set. See that stylesheet for the measurement.
   */
  const [envcardGutter, setEnvcardGutter] = createSignal<SessionEnvironmentCardOccupancy>()
  /**
   * Reservation before the card can report. The lazy chunk plus its persisted-
   * collapse read land after first paint; every painted frame without
   * `data-session-envcard` while the card is going to appear flips the
   * transcript's padding-right afterwards — a full relayout and a restarted
   * paint-stability wait, per switch. Both facts that gate APPEARANCE (a real
   * session, workspace panel closed) are synchronous here, so reserve the
   * card's DEFAULT occupancy (collapsed rail — see createSessionEnvironment-
   * CardState) optimistically; the mount stays the authority and refines or
   * corrects this the moment it reports.
   */
  const optimisticEnvcardOccupancy = createMemo<SessionEnvironmentCardOccupancy | undefined>(() =>
    !draftSession() && !state.workspacePanel.state().open ? "collapsed" : undefined)
  const requiresSessionRef = createMemo(() => !draftSession())
  const missingSessionRef = createMemo(() => requiresSessionRef() && !effectiveSessionRef() && !directory())
  const sessionVisible = props.ctx.isVisible
  const [activated, setActivated] = createSignal(false)
  createEffect(() => {
    if (activated() || !sessionVisible()) return
    setActivated(true)
  })
  const shouldRenderSession = () => sessionVisible() || activated()
  // Construction of the real page waits for the transcript read the activating
  // click already started — see session-mount-settle.ts. It arms on the same
  // condition that decides the page renders at all, so a surface that is only
  // stashed never arms the gate.
  const pageSettled = createSessionMountSettle({
    active: shouldRenderSession,
    pendingTranscript: () => {
      const id = sessionId()
      const dir = directory()
      if (!id || id === "new" || !dir) return
      return getSessionPrefetchPromise(dir, id)
    },
  })
  const activeForHydration = sessionVisible
  const stashedSession = () => (
    <div
      class="size-full"
      data-testid="session-content-stashed"
      data-session-id={sessionId() ?? ""}
      data-session-directory={directory() ?? ""}
    />
  )
  // Named phases, because "how long does building a session page take" was the
  // number this window's attribution kept having to guess at. The probe prints
  // both (`sessionActivate.*` marks and RENDERER PHASES); outside the harness
  // `markRendererPhase`/`measureRendererPhase` are a flag read and a call.
  const sessionPage = () => {
    markRendererPhase("sessionActivate.pageConstruct.start")
    return measureRendererPhase("sessionActivate.pageConstruct", () => <SessionPage />)
  }
  const canRenderWorkspaceScope = createMemo(() => {
    const ref = effectiveSessionRef()
    if (!requiresSessionRef()) return true
    if (!ref) return !!directory()
    return hasBacking(ref)
  })
  const fallbackDirectory = createMemo(() => {
    const dir = directory() ?? props.fallbackDirectory?.()
    return dir && dir !== "/workspace" ? dir : undefined
  })
  const paneDirectory = createMemo(() => {
    const ref = effectiveSessionRef()
    if (ref?.host === "central") {
      const value = directory() ?? fallbackDirectory()
      if (value !== undefined) return { value }
      if (isDirectorylessPiSession({ sessionRef: ref })) return { value: "" }
      return
    }
    if (canRenderWorkspaceScope() && directory() !== undefined) return { value: directory()! }
    return undefined
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
    // Pane-local suspense boundary. Session surfaces create session-scoped
    // queries/lazy chunks on first activation; without this boundary the
    // nearest Suspense is the app-shell bootstrap one, so a session switch
    // suspends the ENTIRE shell — Solid detaches the whole app DOM, every
    // scroll position resets, and the timeline re-renders its range twice
    // (top, then re-anchor to bottom) inside long main-thread tasks. Keeping
    // the boundary here confines the loading state to this pane.
    <Suspense fallback={realSessionLoading()}>
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
                  data-session-envcard={envcardGutter() ?? optimisticEnvcardOccupancy()}
                  data-testid="session-content"
                  data-content-id={meta().id}
                  data-session-id={sessionId() ?? ""}
                  data-session-directory={dir().value}
                >
                  <div class="session-envcard-primary">
                    {/* The page waits for the frames that belong to the click
                        that activated it — see session-mount-settle.ts. Until
                        then this surface presents the page root it would
                        present anyway while its transcript is in flight, so
                        the gate changes WHEN the page is built, not what the
                        user sees while it is not there yet. */}
                    <Show
                      when={pageSettled()}
                      fallback={
                        <SessionLoadingRoot
                          sessionId={sessionId() ?? ""}
                          directory={dir().value}
                          title={meta().content?.title}
                        />
                      }
                    >
                      {sessionPage()}
                    </Show>
                  </div>
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
                      merely disabled. It is also what the CSS expects: an
                      unmounted card reports no occupancy, so the shell drops
                      `data-session-envcard` and reclaims the width. */}
                  <Show when={!draftSession()}>
                    <DeferredEnvironmentCard
                      active={activeForHydration}
                      onOccupancy={setEnvcardGutter}
                    />
                  </Show>
                </div>
              </SessionPaneScope>
            )}
          </Show>
        </Show>
    </Show>
    </Suspense>
  )
}

function DeferredEnvironmentCard(props: {
  active: () => boolean
  onOccupancy: (occupancy: SessionEnvironmentCardOccupancy | undefined) => void
}) {
  const [ready, setReady] = createSignal(false)
  createEffect(() => {
    if (ready() || !props.active()) return
    // The gutter is already reserved, so secondary workspace chrome can wait
    // until the transcript and composer have owned the first paint window.
    // Retained inactive panes must not let an old timer inject lazy CSS and DOM
    // into a different session's foreground activation.
    const timer = setTimeout(() => setReady(true), 250)
    onCleanup(() => clearTimeout(timer))
  })
  return (
    <Show when={ready()}>
      <Suspense fallback={null}>
        <SessionEnvironmentCardMount active={props.active} onOccupancy={props.onOccupancy} />
      </Suspense>
    </Show>
  )
}
