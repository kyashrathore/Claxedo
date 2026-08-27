import {
  For,
  Show,
  batch,
  createComputed,
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { Pane, PaneRect, WorkbenchState } from "./types"
import { useWorkbench, useWorkbenchContext } from "./provider"
import { computePaneRects } from "./reducers/tree-helpers"
import { computeDropEdge } from "./drag-drop"
import { collapsePaneRects, isCollapsedWidth } from "./collapse-projection"
import { useDragSource, workbenchDrag } from "./pointer-drag"
import { matchKey, resolveKeyMap, eventTargetIsEditable } from "./keyboard"
import type { Edge, KeyMap } from "./types"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { DropTargetOverlay } from "./drop-target-overlay"

export type PaneCtx = {
  paneId: string
  isFocused: () => boolean
  isVisible: () => boolean
  requestClose: (opts?: { destroyContent: boolean }) => void
  requestFocus: () => void
}

export type WorkbenchProps = {
  renderContent: (contentId: string, ctx: PaneCtx) => JSX.Element
  renderEmpty?: () => JSX.Element
  keyMap?: Partial<KeyMap>
  mountPolicy?: "always" | "active-only" | "visible-once"
  maxMountedContents?: number
  mountCapCandidate?: (contentId: string) => boolean
  /** Reactive ceiling on retained hidden cap-candidates; visible panes are unaffected. */
  retainedHiddenLimit?: () => number
  onFocusChange?: (paneId: string | null, contentId: string | null) => void
  onPaneResize?: (paneId: string, rect: PaneRect) => void
  onContentOpen?: (contentId: string, paneId: string) => void
  onContentClose?: (contentId: string, reason: "user" | "stale") => void
  onCloseFocusedPane?: (paneId: string, contentId: string | null) => void
}

type DropTarget = { paneId: string; edge: Edge }

/**
 * <Workbench> renders the pane tree (split + leaves), drag-drop overlays,
 * resize dividers, keyboard shortcuts, and slot-based content mounting.
 *
 * It is "controlled": state lives in the consumer (via WorkbenchProvider),
 * and Workbench dispatches reducer-derived state changes via useWorkbench.
 */
export function Workbench(props: WorkbenchProps): JSX.Element {
  const wb = useWorkbench()
  const ctx = useWorkbenchContext()
  const mountPolicy = () => props.mountPolicy ?? "always"

  // -- container ref + ResizeObserver
  let rootEl: HTMLDivElement | undefined
  const [containerSize, setContainerSize] = createSignal({ w: 0, h: 0 })
  onMount(() => {
    if (!rootEl) return
    const update = () => {
      const r = rootEl!.getBoundingClientRect()
      setContainerSize({ w: r.width, h: r.height })
    }
    update()
    const ResizeObserverCtor: typeof ResizeObserver | undefined =
      typeof ResizeObserver !== "undefined" ? ResizeObserver : undefined
    if (ResizeObserverCtor) {
      const ro = new ResizeObserverCtor(() => update())
      ro.observe(rootEl)
      onCleanup(() => ro.disconnect())
    }
  })

  // -- narrow-viewport collapse: below BP_MD the workbench shows exactly one
  //    full-bleed pane and hides the rest. Pure VIEW projection over unchanged
  //    WorkbenchState — splits are preserved-but-hidden, not flattened (see the
  //    WP-C3 collapse design note §1/§4). Measured against our OWN canvas width,
  //    not window.innerWidth, so it composes with the rail/panel insets.
  const collapsed = createMemo(() => isCollapsedWidth(containerSize().w))

  // -- focus change callback
  let lastFocus: { paneId: string | null; contentId: string | null } = { paneId: null, contentId: null }
  createEffect(() => {
    const s = ctx.getState()
    const paneId = s.focusedPaneId
    const pane = paneId ? s.panes.find((p) => p.id === paneId) : undefined
    const contentId = pane?.contentId ?? null
    if (lastFocus.paneId !== paneId || lastFocus.contentId !== contentId) {
      lastFocus = { paneId, contentId }
      props.onFocusChange?.(paneId, contentId)
    }
  })

  // -- onContentOpen: track which content is in which pane.
  let lastOpenSig: Map<string, string> = new Map() // contentId → paneId
  createEffect(() => {
    const s = ctx.getState()
    const next = new Map<string, string>()
    for (const p of s.panes) {
      if (p.contentId) next.set(p.contentId, p.id)
    }
    for (const [cid, pid] of next.entries()) {
      const prev = lastOpenSig.get(cid)
      if (prev !== pid) props.onContentOpen?.(cid, pid)
    }
    lastOpenSig = next
  })
  // -- onContentClose: track contentIds removals.
  let lastAlive: Set<string> = new Set()
  createEffect(() => {
    const ids = new Set(ctx.getState().contentIds)
    for (const id of lastAlive) {
      if (!ids.has(id)) props.onContentClose?.(id, "user")
    }
    lastAlive = ids
  })

  // -- onPaneResize: throttle via RAF.
  // rectMemo = the TRUE split geometry (kept for resize divider math + arrow
  // focus). displayRects = what the DOM actually paints: the true geometry when
  // expanded, the single-pane collapse projection when narrow. Everything the
  // view positions (pane rects, content slots, resize emits) reads displayRects.
  const rectMemo = createMemo(() => computePaneRects(ctx.getState().split.root))
  const displayRects = createMemo(() => (collapsed() ? collapsePaneRects(ctx.getState()) : rectMemo()))
  let pendingFrame: number | null = null
  let lastEmittedRects: Map<string, PaneRect> = new Map()
  const scheduleResizeEmit = () => {
    if (pendingFrame != null) return
    const raf =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => {
            // as-any: fallback timer handle is used only where RAF returns a numeric frame id.
            return setTimeout(() => cb(performance?.now?.() ?? Date.now()), 16) as unknown as number
          }
    pendingFrame = raf(() => {
      pendingFrame = null
      const rects = displayRects()
      const cs = containerSize()
      for (const [pid, rf] of rects) {
        const abs: PaneRect = {
          left: rf.left * cs.w,
          top: rf.top * cs.h,
          width: rf.width * cs.w,
          height: rf.height * cs.h,
        }
        const last = lastEmittedRects.get(pid)
        if (
          !last ||
          last.left !== abs.left ||
          last.top !== abs.top ||
          last.width !== abs.width ||
          last.height !== abs.height
        ) {
          lastEmittedRects.set(pid, abs)
          props.onPaneResize?.(pid, abs)
        }
      }
    })
  }
  createEffect(
    on(
      () => [displayRects(), containerSize()] as const,
      () => scheduleResizeEmit(),
    ),
  )

  // -- keyboard
  const keyMap = createMemo(() => resolveKeyMap(props.keyMap))
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const km = keyMap()
    const s = ctx.getState()
    if (matchKey(e, km.closePane)) {
      if (eventTargetIsEditable(e.target) && km.closePane !== "mod+w") return
      e.preventDefault()
      const paneId = s.focusedPaneId
      if (!paneId) return
      const contentId = s.panes.find((pane) => pane.id === paneId)?.contentId ?? null
      if (props.onCloseFocusedPane) props.onCloseFocusedPane(paneId, contentId)
      else wb.split.close(paneId, { destroyContent: false })
      return
    }
    if (eventTargetIsEditable(e.target)) return
    if (matchKey(e, km.splitRight) || matchKey(e, km.splitDown)) {
      // Keyboard split: reveal the most-recent hidden surface in a new pane
      // beside the focused one. The prior handler passed the focused pane's own
      // contentId into split(), which the self-drop guard always rejected, so
      // the chord was dead (core-panes-split-tabs:591). Splitting a background
      // surface into view is the model-consistent realization — the workbench
      // holds one content per pane, so there is nothing to "duplicate".
      e.preventDefault()
      if (!s.focusedPaneId) return
      const hidden = wb.selectors.mruHiddenContent()
      if (!hidden) return
      const edge = matchKey(e, km.splitRight) ? "right" : "bottom"
      wb.split.split(s.focusedPaneId, edge, hidden)
      return
    }
    if (
      matchKey(e, km.focusLeft) ||
      matchKey(e, km.focusRight) ||
      matchKey(e, km.focusUp) ||
      matchKey(e, km.focusDown)
    ) {
      e.preventDefault()
      const direction =
        matchKey(e, km.focusLeft)
          ? "left"
          : matchKey(e, km.focusRight)
            ? "right"
            : matchKey(e, km.focusUp)
              ? "up"
              : "down"
      moveFocusByDirection(direction, ctx.getState(), wb)
    }
  }
  onMount(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", onKeyDown)
      onCleanup(() => window.removeEventListener("keydown", onKeyDown))
    }
  })

  // -- Drop target: driven by the pointer-drag controller (mouse + touch + pen).
  //    The controller feeds us the live pointer position; we hit-test our panes
  //    with elementFromPoint, drive the edge overlay, and commit the split.
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null)
  const clearDropTarget = () => setDropTarget(null)
  onMount(() => {
    const dispose = workbenchDrag.registerDropZone({
      onMove: (_contentId, x, y) => setDropTarget(hitTestPaneAt(x, y)),
      onDrop: (contentId, x, y) => {
        const target = hitTestPaneAt(x, y)
        clearDropTarget()
        if (target) commitDrop(target.paneId, target.edge, contentId)
      },
      onCancel: clearDropTarget,
    })
    onCleanup(dispose)
  })
  // Escape aborts an in-flight pointer drag (matches the old dragend/drop guard).
  const onWindowKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return
    workbenchDrag.cancel()
  }
  onMount(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", onWindowKey)
      onCleanup(() => window.removeEventListener("keydown", onWindowKey))
    }
  })

  // -- Per-pane CSS rect (positioned absolutely inside root). Reads displayRects
  //    so collapsed mode hides non-focused panes (absent from the map → display:none).
  const paneRectStyle = (paneId: string) => {
    const rects = displayRects()
    const r = rects.get(paneId)
    if (!r) return { display: "none" }
    return {
      position: "absolute" as const,
      left: `${r.left * 100}%`,
      top: `${r.top * 100}%`,
      width: `${r.width * 100}%`,
      height: `${r.height * 100}%`,
    }
  }

  const contentPaneMap = createMemo(() => {
    const map = new Map<string, string>()
    for (const pane of ctx.getState().panes) {
      if (pane.contentId) map.set(pane.contentId, pane.id)
    }
    return map
  })
  // Slots are retained by content id. Reading `contentPaneMap().get(id)` from
  // every slot made all retained surfaces recompute their pane/visibility
  // projections whenever one pane changed content. Mirror the small pane map
  // into keyed store properties so only the content leaving and entering a
  // pane wake; a retained third session remains completely asleep.
  const [contentPaneById, setContentPaneById] = createStore<Record<string, string | undefined>>({})
  let previousContentPaneMap = new Map<string, string>()
  createComputed(() => {
    const next = contentPaneMap()
    batch(() => {
      for (const contentId of previousContentPaneMap.keys()) {
        if (!next.has(contentId)) setContentPaneById(contentId, undefined)
      }
      for (const [contentId, paneId] of next) {
        if (previousContentPaneMap.get(contentId) !== paneId) setContentPaneById(contentId, paneId)
      }
    })
    previousContentPaneMap = next
  })
  // Pane assignment owns mount retention. Display geometry owns visibility.
  // Those differ in collapsed mode: non-focused panes stay assigned (and thus
  // retained) while displayRects omits them from the painted projection.
  const assignedContentSet = createMemo(() => new Set(contentPaneMap().keys()))
  const displayedContentSet = createMemo(() => {
    const rects = displayRects()
    return new Set(
      [...contentPaneMap()].flatMap(([contentId, paneId]) => rects.has(paneId) ? [contentId] : []),
    )
  })
  const [activatedContentIds, setActivatedContentIds] = createSignal<ReadonlySet<string>>(new Set())
  createEffect(() => {
    if (mountPolicy() !== "visible-once") return
    const assigned = assignedContentSet()
    setActivatedContentIds((previous) => {
      if ([...assigned].every((id) => previous.has(id))) return previous
      return new Set([...previous, ...assigned])
    })
  })
  const isAssignedContent = createSelector(
    assignedContentSet,
    (contentId: string, assigned) => assigned.has(contentId),
  )
  const isDisplayedContent = createSelector(
    displayedContentSet,
    (contentId: string, displayed) => displayed.has(contentId),
  )
  const paneOfContent = (contentId: string) => contentPaneById[contentId] ?? null

  const aliveForRender = () => {
    const s = ctx.getState()
    const ids = [...new Set([
      ...s.contentIds,
      ...s.panes.map((pane) => pane.contentId).filter((id): id is string => !!id),
    ])]
    if (mountPolicy() === "always" || mountPolicy() === "visible-once") {
      const eligibleIds = mountPolicy() === "visible-once"
        ? ids.filter((id) => assignedContentSet().has(id) || activatedContentIds().has(id))
        : ids
      const hiddenLimit = props.retainedHiddenLimit?.() ?? Number.MAX_SAFE_INTEGER
      const withinCap = !props.maxMountedContents || eligibleIds.length <= props.maxMountedContents
      // The mount cap only binds on overflow, but the idle governor's hidden
      // limit applies at ANY count — memory reclaim must not depend on how
      // many tabs happen to be open.
      if (withinCap && hiddenLimit === Number.MAX_SAFE_INTEGER) return eligibleIds
      const visibleIds = eligibleIds.filter((id) => assignedContentSet().has(id))
      const alwaysMountedSet = props.mountCapCandidate
        ? new Set(eligibleIds.filter((id) => !props.mountCapCandidate?.(id)))
        : new Set<string>()
      const idSet = new Set(eligibleIds)
      const visibleCandidateIds = visibleIds.filter((id) => !alwaysMountedSet.has(id))
      const retainedCandidateIds = s.contentRecency
        .filter((id) =>
          idSet.has(id) &&
          !assignedContentSet().has(id) &&
          (!props.mountCapCandidate || props.mountCapCandidate(id))
        )
        .slice(0, Math.max(0, Math.min(
          (props.maxMountedContents ?? Number.MAX_SAFE_INTEGER) - visibleCandidateIds.length,
          hiddenLimit,
        )))
      const selected = new Set([...visibleIds, ...alwaysMountedSet, ...retainedCandidateIds])
      // Keep surviving slots in their canonical content order. Recency chooses
      // which slots survive the cap; it must not reorder their live DOM nodes,
      // because moving a scroll owner disconnects it and resets its native
      // offset and virtualizer observers.
      return eligibleIds.filter((id) => selected.has(id))
    }
    return ids.filter((id) => isAssignedContent(id))
  }

  // -- DnD hit-testing (pointer-driven). `elementFromPoint` finds the pane under
  //    the cursor; the ghost is `pointer-events:none` so it never occludes it.
  const hitTestPaneAt = (x: number, y: number): DropTarget | null => {
    if (typeof document === "undefined" || !document.elementFromPoint) return null
    let el: HTMLElement | null = document.elementFromPoint(x, y) as HTMLElement | null
    while (el && !el.dataset?.paneId) el = el.parentElement
    const paneId = el?.dataset?.paneId
    if (!paneId) return null
    const rect = el!.getBoundingClientRect()
    const edge = computeDropEdge(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      x,
      y,
    )
    return { paneId, edge }
  }
  const commitDrop = (paneId: string, edge: Edge, contentId: string) => {
    // Reject ids we don't own (external/stale). Self-drop onto the same pane is
    // a no-op inside the split reducer's own guard, preserved unchanged.
    if (!ctx.getState().contentIds.includes(contentId)) return
    wb.split.split(paneId, edge, contentId)
  }

  // -- Resize divider (top-level only for now; nested splits could use path "a"|"b")
  // Detect if root is a split; if so, render a divider.
  const rootSplit = createMemo(() => {
    const r = ctx.getState().split.root
    return r && r.t === "split" ? r : null
  })
  const dropTargetPaneStyle = (paneId: string): JSX.CSSProperties => {
    const style = paneRectStyle(paneId)
    if (style.display === "none") return style
    return {
      ...style,
      "z-index": "45",
      "pointer-events": "none",
    }
  }

  return (
    <div
      ref={(el) => (rootEl = el)}
      data-testid="workbench-root"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        "background-color": "var(--background-base)",
      }}
      tabindex="-1"
    >
      <Show
        when={ctx.getState().panes.length > 0}
        fallback={<div data-testid="empty" class="h-full w-full">{props.renderEmpty?.()}</div>}
      >
        {/* Pane chrome layers — rendered absolutely positioned */}
        <For each={ctx.getState().panes}>
          {(pane) => {
            const renderEmptyForPane = () => (
              <div data-testid="empty" class="h-full w-full">{props.renderEmpty?.()}</div>
            )
            return (
              <div
                data-testid={`pane-${pane.id}`}
                data-pane-id={pane.id}
                style={{
                  ...paneRectStyle(pane.id),
                  display: paneRectStyle(pane.id).display === "none" ? "none" : "block",
                  overflow: "hidden",
                  "box-sizing": "border-box",
                }}
                class="bg-background-base/10"
                onMouseDown={() => wb.split.focus(pane.id)}
              >
                <Show when={!pane.contentId}>{renderEmptyForPane()}</Show>
              </div>
            )
          }}
        </For>

        {/* Top-level resize divider, if root is a split. Absent in collapsed
            (single-pane) mode — there is nothing to resize when only one pane
            is visible, matching the panel's own !isMobile()-gated separator. */}
        <Show when={!collapsed() && rootSplit()}>
          {(rs) => {
            const onPointerDown = (e: PointerEvent) => {
              const startRect = rootEl?.getBoundingClientRect()
              if (!startRect) return
              const onMove = (ev: PointerEvent) => {
                if (rs().dir === "h") {
                  const ratio = (ev.clientX - startRect.left) / startRect.width
                  wb.split.resize([], Math.min(1, Math.max(0, ratio)))
                } else {
                  const ratio = (ev.clientY - startRect.top) / startRect.height
                  wb.split.resize([], Math.min(1, Math.max(0, ratio)))
                }
              }
              const onUp = () => {
                window.removeEventListener("pointermove", onMove)
                window.removeEventListener("pointerup", onUp)
              }
              window.addEventListener("pointermove", onMove)
              window.addEventListener("pointerup", onUp)
              e.preventDefault()
            }
            // Keyboard resize parity for the pointer-drag divider: arrow keys
            // nudge the split ratio so keyboard/screen-reader users can resize
            // panes (previously pointer-only, a named a11y gap).
            const KEYBOARD_STEP = 0.02
            const onKeyDown = (e: KeyboardEvent) => {
              const root = rs()
              const horizontal = root.dir === "h"
              let delta = 0
              if (horizontal && e.key === "ArrowLeft") delta = -KEYBOARD_STEP
              else if (horizontal && e.key === "ArrowRight") delta = KEYBOARD_STEP
              else if (!horizontal && e.key === "ArrowUp") delta = -KEYBOARD_STEP
              else if (!horizontal && e.key === "ArrowDown") delta = KEYBOARD_STEP
              else if (e.key === "Home") delta = -1
              else if (e.key === "End") delta = 1
              if (delta === 0) return
              e.preventDefault()
              wb.split.resize([], Math.min(1, Math.max(0, root.size + delta)))
            }
            const dividerStyle = (): JSX.CSSProperties => {
              const root = rs()
              if (root.dir === "h") {
                return {
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `calc(${root.size * 100}% - 2px)`,
                  width: "4px",
                  cursor: "col-resize",
                  "z-index": "10",
                  background:
                    "linear-gradient(to right, transparent 0, transparent 1.5px, var(--border-weaker-base) 1.5px, var(--border-weaker-base) 2.5px, transparent 2.5px)",
                }
              }
              return {
                position: "absolute",
                left: 0,
                right: 0,
                top: `calc(${root.size * 100}% - 2px)`,
                height: "4px",
                cursor: "row-resize",
                "z-index": "10",
                background:
                  "linear-gradient(to bottom, transparent 0, transparent 1.5px, var(--border-weaker-base) 1.5px, var(--border-weaker-base) 2.5px, transparent 2.5px)",
              }
            }
            return (
              <div
                data-testid="workbench-divider"
                role="separator"
                tabindex="0"
                aria-label="Resize panes"
                aria-orientation={rs().dir === "h" ? "vertical" : "horizontal"}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(rs().size * 100)}
                style={dividerStyle()}
                onPointerDown={onPointerDown}
                onKeyDown={onKeyDown}
              />
            )
          }}
        </Show>

        {/* Content slots — absolutely positioned, mount retention. */}
        <For each={aliveForRender()}>
          {(contentId) => {
            const visible = createMemo(() => isDisplayedContent(contentId))
            const paneId = createMemo(() => paneOfContent(contentId))
            const inactive = createMemo(() => {
              const pid = paneId()
              const focused = ctx.getState().focusedPaneId
              return !!focused && !!pid && focused !== pid
            })
            const slotStyle = (): JSX.CSSProperties => {
              const pid = paneId()
              if (!pid) {
                // Stashed content stays mounted but fully hidden and cheap.
                // `visibility: hidden` is load-bearing: it is what makes the
                // stashed slot invisible to CSS visibility queries (Playwright
                // `:visible`, `elementFromPoint`) while keeping layout alive —
                // `opacity: 0` alone still counts as visible, so a stale
                // cross-workspace draft composer read as a second "visible"
                // composer/chip. aria-hidden/inert on the slot cover the
                // accessibility tree and interaction.
                //
                // `content-visibility: hidden` is what makes "cheap" true. A
                // stashed slot shows the user nothing, but `visibility: hidden`
                // does not remove it from style recalculation: every stashed
                // transcript still resolved its ~100 elements on every
                // whole-document pass, and the workbench holds up to
                // MAX_OPEN_SURFACES of them. Display-locking is the only thing
                // that takes a subtree out of that pass, and it is the same
                // mechanism the hidden-pane branch below already relies on to
                // keep re-show fast: locking preserves the subtree's cached
                // layout state rather than discarding it the way
                // `display: none` would.
	                return {
	                  position: "absolute",
	                  inset: "0",
	                  width: "100%",
	                  height: "100%",
	                  opacity: "0",
	                  visibility: "hidden",
	                  "content-visibility": "hidden",
	                  contain: "strict",
	                  "pointer-events": "none",
	                  overflow: "hidden",
                }
              }
              const rect = displayRects().get(pid)
              if (!rect) return { display: "none" }
              // Hidden pane tabs keep their subtree's RENDERING STATE:
              // `display: none` discarded layout, so every tab re-show
              // re-laid-out its whole timeline (a ~80ms drift-and-settle on
              // heavy sessions). `content-visibility: hidden` skips rendering
              // work entirely while PRESERVING the cached layout state for the
              // subtree — re-show restores it instead of recomputing it.
              // aria-hidden/inert on the slot cover semantics + interaction.
              return {
                position: "absolute",
                left: `${rect.left * 100}%`,
                top: `${rect.top * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
                display: "block",
                overflow: "hidden",
                // A workbench content slot is a complete surface with explicit
                // geometry. Bound its layout and paint work to that surface
                // instead of letting a newly mounted session expand the shell's
                // layout scope. `strict` is safe here because the slot already
                // owns a fixed rectangle and clips overflow.
                contain: "strict",
                ...(visible()
                  ? {}
                  : {
                      "content-visibility": "hidden" as const,
                      "pointer-events": "none" as const,
                    }),
              }
            }
            const paneCtx: PaneCtx = {
              paneId: paneId() ?? "",
              isFocused: () => {
                const pid = paneId()
                return pid !== null && ctx.getState().focusedPaneId === pid
              },
              isVisible: () => visible(),
              requestClose: (opts) => {
                const pid = paneId()
                if (pid) wb.split.close(pid, opts ?? { destroyContent: false })
              },
              requestFocus: () => {
                const pid = paneId()
                if (pid) wb.split.focus(pid)
              },
            }
            // `data-pane-id` on the slot lets hit-testing route a drop over
            // rendered content up to its owning pane (elementFromPoint → slot).
            return (
              <div
                data-workbench-content={contentId}
                data-pane-id={paneId() ?? undefined}
                // Absence is the canonical exposed state. Avoid installing a
                // redundant `aria-hidden="false"` attribute on every cold mount;
                // hidden retained slots still carry the explicit true state.
                aria-hidden={!visible() ? "true" : undefined}
                inert={!visible()}
                style={slotStyle()}
                // No transition on the slot itself: animating opacity/filter
                // across EVERY tab/session switch forced a 100ms style+paint
                // storm inside exactly the window where switch latency is
                // measured (and felt). The inactive dimming still applies —
                // it just snaps, which reads as faster, not worse.
                classList={{
                  "opacity-55 saturate-[0.7]": inactive(),
                }}
                onMouseDown={() => {
                  const pid = paneId()
                  if (pid) wb.split.focus(pid)
                }}
              >
                {props.renderContent(contentId, paneCtx)}
              </div>
            )
          }}
        </For>

        <For each={ctx.getState().panes}>
          {(pane) => (
            <>
              <Show when={pane.contentId}>
                {(cid) => (
                  <div
                    data-testid={`pane-handle-zone-${pane.id}`}
                    style={{
                      ...paneRectStyle(pane.id),
                      display: paneRectStyle(pane.id).display === "none" ? "none" : "block",
                      // Positioning wrapper only — MUST stay pointer-events:none so
                      // the pane's rendered content underneath keeps receiving clicks.
                      "pointer-events": "none",
                      "z-index": "35",
                    }}
                  >
                    {/* The REAL pane-drag input surface. WP-C3a fix: the drag source
                        used to be attached to the pointer-events:none wrapper above,
                        so it could NEVER receive a pointerdown — the desktop
                        pane-drag path was entirely dead. Attaching it to this small
                        grip (pointer-events:auto) is what actually receives input; a
                        user grabs it and drops the pane onto another pane's edge to
                        split. Hover-revealed to keep the visual/hit footprint tiny. */}
                    <div
                      data-testid={`pane-handle-${pane.id}`}
                      aria-hidden="true"
                      title="Drag to move pane"
                      ref={(el) => {
                        const dispose = useDragSource(el, {
                          contentId: () => cid(),
                          sourceKind: "workbench-pane",
                          // Dedicated grip, never a scroll surface.
                          touchAction: "none",
                        })
                        onCleanup(dispose)
                      }}
                      class="absolute left-2 top-2 flex size-5 cursor-grab items-center justify-center rounded border border-border-weak-base/35 bg-background-base/55 text-icon-weak-base opacity-0 backdrop-blur-sm transition-opacity duration-100 hover:opacity-100 active:cursor-grabbing"
                      style={{ "pointer-events": "auto" }}
                    >
                      <Icon name="dot-grid" size="small" />
                    </div>
                  </div>
                )}
              </Show>
              <Show when={ctx.getState().panes.length > 1 && pane.contentId}>
                <div
                  data-testid={`pane-close-zone-${pane.id}`}
                  style={{
                    ...paneRectStyle(pane.id),
                    display: paneRectStyle(pane.id).display === "none" ? "none" : "block",
                    "pointer-events": "none",
                    "z-index": "42",
                  }}
                >
                  <button
                    type="button"
                    aria-label="Close Pane"
                    data-testid={`pane-close-${pane.id}`}
                    draggable={false}
                    class="absolute right-2 top-2 flex size-5 items-center justify-center rounded border border-border-weak-base/35 bg-background-base/55 p-0 text-icon-weak-base opacity-35 backdrop-blur-sm outline-none transition-[opacity,background-color,color,border-color] duration-100 hover:border-border-base/70 hover:bg-surface-base-hover/90 hover:text-icon-base hover:opacity-100 focus-visible:border-border-base/70 focus-visible:bg-surface-base-hover/90 focus-visible:text-icon-base focus-visible:opacity-100"
                    style={{ "pointer-events": "auto" }}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      wb.split.close(pane.id, { destroyContent: false })
                    }}
                  >
                    <Icon name="close-small" size="small" />
                  </button>
                </div>
              </Show>
            </>
          )}
        </For>

        <Show when={dropTarget()}>
          {(target) => (
            <div
              data-testid={`drop-target-${target().paneId}`}
              style={dropTargetPaneStyle(target().paneId)}
              class="workbench-drop-target"
            >
              <DropTargetOverlay edge={target().edge} />
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

function moveFocusByDirection(
  direction: "left" | "right" | "up" | "down",
  state: WorkbenchState,
  wb: ReturnType<typeof useWorkbench>,
) {
  const rects = computePaneRects(state.split.root)
  const focusedId = state.focusedPaneId
  if (!focusedId) return
  const me = rects.get(focusedId)
  if (!me) return
  const cx = me.left + me.width / 2
  const cy = me.top + me.height / 2
  let best: { id: string; score: number } | null = null
  for (const [pid, r] of rects) {
    if (pid === focusedId) continue
    const rcx = r.left + r.width / 2
    const rcy = r.top + r.height / 2
    let valid = false
    let score = 0
    if (direction === "left") {
      valid = rcx < cx
      score = cx - rcx + Math.abs(rcy - cy) * 2
    } else if (direction === "right") {
      valid = rcx > cx
      score = rcx - cx + Math.abs(rcy - cy) * 2
    } else if (direction === "up") {
      valid = rcy < cy
      score = cy - rcy + Math.abs(rcx - cx) * 2
    } else {
      valid = rcy > cy
      score = rcy - cy + Math.abs(rcx - cx) * 2
    }
    if (!valid) continue
    if (!best || score < best.score) best = { id: pid, score }
  }
  if (best) wb.split.focus(best.id)
}
