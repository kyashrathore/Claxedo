import { createSignal } from "solid-js"

/**
 * Pointer-events drag controller for pane/tab/session drags: one input layer
 * for mouse, touch, and pen (native HTML5 drag-and-drop never fires on touch).
 * Hand-rolled because the workbench's drop semantics are bespoke edge geometry
 * no generic DnD library models.
 *
 * One module-level store (`workbenchDrag`): sources feed it through
 * `useDragSource` (`begin`/`move`/`end`/`cancel`), drop zones subscribe via
 * `registerDropZone`. The payload is the workbench `contentId`;
 * `computeDropEdge` and `wb.split.split` remain the edge oracle and split
 * commit.
 */

export type DragSourceKind = "workbench-pane" | "tab" | "navigation-row"

/**
 * A registered drop target. The controller drives these callbacks from the live
 * pointer stream so the zone can hit-test and commit without knowing anything
 * about pointer plumbing. `x`/`y` are viewport (client) coordinates.
 */
export type DropZone = {
  onMove?: (contentId: string, x: number, y: number) => void
  /** Return true when the zone commits the drop, so the source can tell a
   *  completed drag from a release over nothing. */
  onDrop?: (contentId: string, x: number, y: number) => boolean | void
  onCancel?: () => void
}

type DragState = {
  active: boolean
  contentId: string | null
  sourceKind: DragSourceKind | null
  x: number
  y: number
}

// One module-scope controller: sources feed it, drop zones subscribe. This
// single shared instance is the whole point of the design (one engine unifying
// mouse/touch/pen across components), so its module-level state is intentional.
const [state, setState] = createSignal<DragState>({
  active: false,
  contentId: null,
  sourceKind: null,
  x: 0,
  y: 0,
})

// Every fan-out below iterates `dropZones.slice()`, not the list itself: a
// zone's callback may run the cleanup `registerDropZone` handed it, which
// splices the live list mid-iteration and would skip the next zone.
const dropZones: DropZone[] = []

let ghostEl: HTMLElement | null = null

function ensureGhost(label: string) {
  if (typeof document === "undefined") return
  if (!ghostEl) {
    ghostEl = document.createElement("div")
    ghostEl.setAttribute("data-testid", "workbench-drag-ghost")
    Object.assign(ghostEl.style, {
      position: "fixed",
      top: "0",
      left: "0",
      zIndex: "1000",
      pointerEvents: "none",
      padding: "3px 9px",
      borderRadius: "var(--radius-md)",
      fontSize: "var(--font-size-small)",
      lineHeight: "var(--line-height-none)",
      maxWidth: "220px",
      overflow: "hidden",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
      background: "var(--surface-base-active)",
      color: "var(--text-base)",
      boxShadow: "var(--shadow-drag-preview)",
      transform: "translate(-9999px, -9999px)",
    } satisfies Partial<CSSStyleDeclaration>)
    document.body.appendChild(ghostEl)
  }
  ghostEl.textContent = label
}

function positionGhost(x: number, y: number) {
  if (ghostEl) ghostEl.style.transform = `translate(${x + 12}px, ${y + 12}px)`
}

function removeGhost() {
  if (ghostEl?.parentNode) ghostEl.parentNode.removeChild(ghostEl)
  ghostEl = null
}

export const workbenchDrag = {
  active: () => state().active,
  contentId: () => state().contentId,
  sourceKind: () => state().sourceKind,
  x: () => state().x,
  y: () => state().y,

  /** A drop target registers here (returns its own de-register cleanup). */
  registerDropZone(zone: DropZone): () => void {
    dropZones.push(zone)
    return () => {
      const idx = dropZones.indexOf(zone)
      if (idx >= 0) dropZones.splice(idx, 1)
    }
  },

  /** A source calls this once its threshold is crossed. */
  begin(input: { contentId: string; sourceKind: DragSourceKind; x: number; y: number; label?: string }) {
    setState({ active: true, contentId: input.contentId, sourceKind: input.sourceKind, x: input.x, y: input.y })
    ensureGhost(input.label ?? "")
    positionGhost(input.x, input.y)
    for (const zone of dropZones.slice()) zone.onMove?.(input.contentId, input.x, input.y)
  },

  /** Live pointer position during a drag. */
  move(x: number, y: number) {
    const s = state()
    if (!s.active) return
    setState({ ...s, x, y })
    positionGhost(x, y)
    if (s.contentId == null) return
    for (const zone of dropZones.slice()) zone.onMove?.(s.contentId, x, y)
  },

  /** Pointer released over a target — commit the drop. Returns whether any zone took it. */
  end(): boolean {
    const s = state()
    if (!s.active) return false
    setState({ ...s, active: false })
    removeGhost()
    if (s.contentId == null) return false
    let consumed = false
    for (const zone of dropZones.slice()) {
      if (zone.onDrop?.(s.contentId, s.x, s.y) === true) consumed = true
    }
    return consumed
  },

  /** Drag aborted (Escape / pointercancel) — targets must NOT commit. */
  cancel() {
    const s = state()
    if (!s.active) return
    setState({ ...s, active: false })
    removeGhost()
    for (const zone of dropZones.slice()) zone.onCancel?.()
  },
}

const MOUSE_THRESHOLD_PX = 5
const TOUCH_THRESHOLD_PX = 8
const TOUCH_LONG_PRESS_MS = 250

export type DragSourceOptions = {
  /**
   * Resolve the workbench content id to carry; `undefined` aborts the drag.
   *
   * CONTRACT — this is invoked ONLY when a drag actually begins (the movement
   * threshold is crossed, or a touch long-press fires), NEVER on a plain
   * pointerdown / tap / click. That deferral is load-bearing: sidebar rows mint
   * their content id via a SIDE-EFFECTING resolver (`prepareSessionDrag` →
   * `openSession`), so resolving eagerly on pointerdown would open a session on
   * every press. Resolving here is the single, intentional "the user is really
   * dragging" side effect. It is called at most once per drag.
   */
  contentId: () => string | undefined
  sourceKind: DragSourceKind
  /** Optional ghost label (defaults to empty). Resolved lazily at drag-begin. */
  label?: () => string | undefined
  /** Gate: return false to disable dragging (e.g. non-draggable tab kinds). */
  enabled?: () => boolean
  /**
   * CSS `touch-action` for the source element. Defaults to `"pan-y"` so a
   * vertical list still scrolls by touch (the drag is gated behind a
   * long-press). `"pan-x"` for a horizontal tab strip; `"none"` only for a
   * dedicated grip — on anything that fills a scroll container it kills touch
   * scrolling.
   */
  touchAction?: string
  /** Fires when a drag actually starts (past threshold), NOT on every pointerdown. */
  onBegin?: (event: PointerEvent) => void
  /** Fires when the drag ends or aborts. */
  onEnd?: () => void
  /**
   * The pointer was released without any drop zone taking the content — a press
   * that drifted past the threshold and landed back on nothing. The source's own
   * `click` cannot serve here: capture is held by the source element, so the
   * browser retargets the click off any inner activate control onto it, and the
   * press would otherwise be neither a drop nor a click.
   */
  onDropMissed?: () => void
}

/**
 * Attach pointer-drag behavior to a source element. Apply from a Solid `ref`.
 * Returns a cleanup that removes listeners (register it with `onCleanup`).
 *
 * Mouse/pen: drag starts after a small movement threshold. Touch: drag starts
 * on a ~250ms long-press, and is ABORTED if the finger moves first (that is a
 * scroll, not a drag) — this is what lets the tab strip and sidebar list stay
 * scrollable. The element's `touch-action` (default `"pan-y"`, see
 * `DragSourceOptions.touchAction`) leaves the axis-appropriate pan gesture to
 * the browser; pointer capture is taken ONLY once the drag begins, so before
 * that the browser is free to scroll natively.
 */
export function useDragSource(el: HTMLElement, options: DragSourceOptions): () => void {
  el.style.touchAction = options.touchAction ?? "pan-y"

  let pointerId: number | null = null
  let startX = 0
  let startY = 0
  let dragging = false
  let longPressTimer: ReturnType<typeof setTimeout> | null = null

  const clearLongPress = () => {
    if (longPressTimer != null) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
  }

  const teardownSession = () => {
    if (pointerId != null) {
      try {
        el.releasePointerCapture(pointerId)
      } catch {
        // ignore — capture may not have been granted (jsdom / already released)
      }
    }
    pointerId = null
    clearLongPress()
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    window.removeEventListener("pointercancel", onCancel)
    if (dragging) {
      dragging = false
      options.onEnd?.()
    }
  }

  const beginDrag = (event: PointerEvent, x: number, y: number) => {
    // Deferred, at-most-once resolution — this is the FIRST time we touch the
    // (possibly side-effecting) resolver, and only because a real drag is
    // starting. If it declines (undefined id) we abort without any drag state.
    const cid = options.contentId()
    if (!cid) {
      teardownSession()
      return
    }
    dragging = true
    clearLongPress()
    // Capture only now: before a drag begins the browser must stay free to
    // scroll the list/strip natively (touch-action pan-*). Capturing on
    // pointerdown would have suppressed that scroll.
    if (pointerId != null) {
      try {
        el.setPointerCapture(pointerId)
      } catch {
        // ignore — jsdom/happydom may not implement pointer capture
      }
    }
    workbenchDrag.begin({ contentId: cid, sourceKind: options.sourceKind, x, y, label: options.label?.() })
    options.onBegin?.(event)
  }

  const onMove = (event: PointerEvent) => {
    if (pointerId == null || event.pointerId !== pointerId) return
    if (dragging) {
      event.preventDefault()
      workbenchDrag.move(event.clientX, event.clientY)
      return
    }
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    const isTouch = event.pointerType === "touch"
    const threshold = isTouch ? TOUCH_THRESHOLD_PX : MOUSE_THRESHOLD_PX
    if (Math.hypot(dx, dy) < threshold) return
    if (isTouch) {
      // Moved before the long-press elapsed → this is a scroll, not a drag.
      teardownSession()
      return
    }
    beginDrag(event, event.clientX, event.clientY)
  }

  const onUp = (event: PointerEvent) => {
    if (pointerId != null && event.pointerId !== pointerId) return
    // `workbenchDrag.active()` is read before `end()`: Escape aborts through
    // `cancel()` while this source still holds the pointer, and that release
    // must stay an abort rather than fall through to the missed-drop click.
    const recoverable = dragging && workbenchDrag.active()
    const consumed = dragging ? workbenchDrag.end() : false
    teardownSession()
    if (recoverable && !consumed) options.onDropMissed?.()
  }

  const onCancel = (event: PointerEvent) => {
    if (pointerId != null && event.pointerId !== pointerId) return
    if (dragging) workbenchDrag.cancel()
    teardownSession()
  }

  const onDown = (event: PointerEvent) => {
    if (options.enabled && !options.enabled()) return
    if (event.button != null && event.button > 0) return // primary button only
    // Do NOT resolve `options.contentId()` here — it may side-effect (mint/open
    // content). Arming is unconditional for an enabled source; the resolver is
    // consulted once, later, in `beginDrag` (see the contract on `contentId`).
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    dragging = false
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    if (event.pointerType === "touch") {
      longPressTimer = setTimeout(() => {
        longPressTimer = null
        if (pointerId != null && !dragging) beginDrag(event, startX, startY)
      }, TOUCH_LONG_PRESS_MS)
    }
  }

  el.addEventListener("pointerdown", onDown)
  return () => {
    el.removeEventListener("pointerdown", onDown)
    teardownSession()
  }
}
