import type { JSX } from "solid-js"

export type ReviewScrollPosition = {
  top: number
  anchorPath?: string
  anchorOffset?: number
}

export const REVIEW_SCROLL_DIAGNOSTIC_PROPERTY = "__claxedoReviewScrollDiagnostic"

export type ReviewScrollDiagnostic = {
  action: string
  attempt: number
  canRecord: boolean
  currentTop?: number
  position: ReviewScrollPosition
  restoring: boolean
  visible: boolean
}

export function createReviewScrollRestoration(input: {
  visible: () => boolean
  canRecord: () => boolean
  initial?: ReviewScrollPosition
  onChange?: (position: ReviewScrollPosition) => void
  /**
   * Whether `path` exists in the canonical review corpus. CodeView only mounts
   * rows near the scroll position, so an absent row proves
   * nothing — only this predicate can prove the anchor file was deleted or
   * renamed while Review was closed. Return `false` for a known-absent path:
   * restoration then settles on the clamped pixel top instead of waiting for
   * a row that can never mount. Return `true` — or `undefined` while the
   * corpus has not resolved yet — to keep waiting. Omitting the predicate
   * preserves the wait-for-anchor behavior.
   */
  anchorExists?: (path: string) => boolean | undefined
}) {
  let frame: number | undefined
  let captureFrame: number | undefined
  let observer: MutationObserver | undefined
  let element: HTMLElement | undefined
  let restoring = false
  /**
   * Where the review surface's own document places a file, in the scroll
   * element's coordinates, whether or not its row is rendered.
   *
   * The retained pixel top describes the document as it was when the position
   * was captured. A surface whose rows change height as their content arrives —
   * a summary row reserving one header, then becoming a full diff — has a
   * different document by the time the restore runs, and the retained top can
   * clamp past the end of the shorter one. When the surface can answer this,
   * its answer is the anchor's real position and is used instead.
   */
  let anchorTop: ((path: string) => number | undefined) | undefined
  let position: ReviewScrollPosition = input.initial ?? { top: 0 }
  let action = "created"
  let lastAttempt = 0

  const diagnostic = (): ReviewScrollDiagnostic => ({
    action,
    attempt: lastAttempt,
    canRecord: input.canRecord(),
    currentTop: element?.scrollTop,
    position: { ...position },
    restoring,
    visible: input.visible(),
  })

  const anchorFor = (path: string | undefined) => path && element
    ? Array.from(element.querySelectorAll<HTMLElement>("[data-review-file]"))
      .find((candidate) => candidate.dataset.reviewFile === path)
    : undefined
  const nearestAnchor = () => {
    if (!element) return undefined
    const viewportTop = element.getBoundingClientRect().top
    return Array.from(element.querySelectorAll<HTMLElement>("[data-review-file]"))
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .toSorted((left, right) =>
        Math.abs(left.getBoundingClientRect().top - viewportTop) -
        Math.abs(right.getBoundingClientRect().top - viewportTop)
      )[0]
  }
  const publish = (next: ReviewScrollPosition) => {
    position = next
    input.onChange?.(next)
  }
  const cancelPendingCapture = () => {
    if (captureFrame === undefined) return
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(captureFrame)
    captureFrame = undefined
  }
  const capture = () => {
    // Every capture supersedes a pending next-frame capture from `remember`:
    // cancel it so the anchor is recorded exactly once per settled position.
    cancelPendingCapture()
    // A hidden Review body can have its native scrollTop clamped to zero and
    // every child rectangle collapsed. That is not a new user position. Never
    // let a post-activation effect replace the last visible semantic snapshot
    // with hidden geometry.
    if (!element || !input.visible()) return
    // `remember` publishes every observed scrollTop immediately. If layout has
    // changed the native value without delivering a scroll event, the DOM is
    // not authoritative yet (a tab insertion can transiently clamp it to 0).
    if (Math.abs(element.scrollTop - position.top) > 0.5) return
    const anchor = nearestAnchor()
    if (!anchor) return
    publish({
      top: element.scrollTop,
      anchorPath: anchor.dataset.reviewFile,
      anchorOffset: anchor.getBoundingClientRect().top - element.getBoundingClientRect().top,
    })
    action = "captured"
  }
  const stopObserver = () => {
    observer?.disconnect()
    observer = undefined
  }
  const apply = (attempt = 0) => {
    lastAttempt = attempt
    if (!element || !input.visible()) {
      action = "apply-hidden"
      restoring = false
      return
    }
    const anchor = anchorFor(position.anchorPath)
    if (position.anchorPath && !anchor) {
      if (input.anchorExists?.(position.anchorPath) === false) {
        // The anchor file is gone from the corpus itself (deleted or renamed
        // while Review was closed), so no amount of waiting materializes its
        // row. Settle on the retained pixel top, clamped to the current
        // extent, and end the restoring state so scroll ownership returns to
        // the user immediately.
        stopObserver()
        element.scrollTop = Math.max(0, Math.min(position.top, element.scrollHeight - element.clientHeight))
        restoring = false
        action = "anchor-missing-settled"
        return
      }
      // The anchor row may not exist yet: the surface renders rows around the
      // scroll position, so land where the anchor is and let that scroll mount
      // it. The surface's own document is asked first, because the retained
      // pixel top describes the document as it was at capture. The observer
      // then re-runs this for the precise anchor-offset correction.
      const documentTop = anchorTop?.(position.anchorPath)
      const landing = documentTop !== undefined
        ? documentTop - (position.anchorOffset ?? 0)
        : position.top
      if (Math.abs(element.scrollTop - landing) > 0.5) element.scrollTop = landing
      action = documentTop !== undefined ? "waiting-for-anchor-row" : "waiting-for-anchor"
      if (!observer && typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(() => apply())
        observer.observe(element, { childList: true, subtree: true })
      }
      return
    }
    stopObserver()
    element.scrollTop = anchor && position.anchorOffset !== undefined
      ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.anchorOffset
      : position.top
    action = "applied"
    if (typeof requestAnimationFrame !== "function") {
      restoring = false
      action = "settled"
      return
    }
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!element || !input.visible()) {
        restoring = false
        return
      }
      const currentAnchor = anchorFor(position.anchorPath)
      const error = currentAnchor && position.anchorOffset !== undefined
        ? Math.abs(currentAnchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.anchorOffset)
        : Math.abs(element.scrollTop - position.top)
      if (attempt < 8 && (attempt < 1 || error > 0.5)) {
        apply(attempt + 1)
        return
      }
      restoring = false
      action = "settled"
    })
  }
  const restore = () => {
    if (!element || !input.visible()) return
    if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
    frame = undefined
    restoring = true
    action = "restore-requested"
    apply()
  }
  // No resize handling here: reflow inside a live surface is CodeView's. Its
  // rendered rows are flex children of its sticky container, so a row that
  // reflows at a new width grows that container, and the resize entry the
  // browser delivers for it re-measures every rendered row and re-anchors the
  // scroll position. What this module owns is the position that outlives the
  // surface — the engine and its geometry are gone across a tab switch.
  const bind = (next: HTMLElement) => {
    element = next
    action = "bound"
    Object.defineProperty(next, REVIEW_SCROLL_DIAGNOSTIC_PROPERTY, {
      configurable: true,
      value: diagnostic,
    })
    restore()
  }
  /**
   * Also expose the diagnostic on an element that outlives the Review body.
   * With only the active tab mounted, the scroll element does not exist while
   * a file tab is active, but the retained semantic position still does; the
   * workspace root is where tooling reads it in that state.
   */
  let diagnosticHost: HTMLElement | undefined
  const bindDiagnosticHost = (host: HTMLElement) => {
    diagnosticHost = host
    Object.defineProperty(host, REVIEW_SCROLL_DIAGNOSTIC_PROPERTY, {
      configurable: true,
      value: diagnostic,
    })
  }
  const remember: JSX.EventHandler<HTMLDivElement, Event> = (event) => {
    if (!input.canRecord() || restoring) return
    const target = event.currentTarget
    publish({ ...position, top: target.scrollTop })
    // Capture the semantic anchor on the next frame, once layout has settled
    // for this scroll position. The window is one frame (not a timer) and the
    // capture is cancellable: `dispose` flushes it synchronously, so a tab
    // switch that unmounts the surface immediately after a scroll still
    // records the anchor instead of leaving a pixel-only position behind.
    cancelPendingCapture()
    if (typeof requestAnimationFrame !== "function") {
      capture()
      return
    }
    captureFrame = requestAnimationFrame(() => {
      captureFrame = undefined
      if (element !== target || !input.canRecord()) return
      capture()
    })
  }
  const dispose = () => {
    if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
    // An unmount inside the one-frame capture window must not lose the
    // anchor: flush the pending capture synchronously while the element still
    // holds its final geometry. `capture` cancels the frame itself, so
    // nothing runs after this cleanup.
    if (captureFrame !== undefined) capture()
    stopObserver()
    if (element) Reflect.deleteProperty(element, REVIEW_SCROLL_DIAGNOSTIC_PROPERTY)
    if (diagnosticHost) Reflect.deleteProperty(diagnosticHost, REVIEW_SCROLL_DIAGNOSTIC_PROPERTY)
    // Release the viewport: a deactivated tab's detached subtree must not stay
    // pinned by this closure between dispose and the next bind. The surface's
    // geometry reader holds its whole engine, so it goes with it.
    element = undefined
    anchorTop = undefined
    frame = undefined
  }

  return {
    bind,
    bindDiagnosticHost,
    /**
     * Bind the review surface's document geometry, or clear it when that
     * surface goes away. A surface that owns no document of its own never
     * calls this, and restoration keeps using the retained pixel top.
     */
    bindAnchorTop: (resolve?: (path: string) => number | undefined) => {
      anchorTop = resolve
    },
    capture,
    dispose,
    remember,
    restore,
    /** The anchor of the position the next restore will target, if any. */
    anchorPath: () => position.anchorPath,
  }
}
