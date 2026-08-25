/**
 * Canonical reveal for benchmark elements.
 *
 * Setup steps have to bring a row into view before the harness can act on it,
 * but they must not disturb the surface under audit while doing so.
 * `scrollIntoView({ block: "center", inline: "center" })` always scrolls -- even
 * for a row that is already fully on screen -- which visibly jumps a long
 * session sidebar and contaminates a visual audit of the very frames the
 * benchmark is about to record.
 *
 * The canonical reveal is:
 *
 *   1. already fully visible inside its scrollers -> do nothing at all;
 *   2. otherwise the smallest scroll that brings it fully in (the `block:
 *      "nearest"` semantics), clamped to what the scroller can actually
 *      deliver so an unrevealable element terminates instead of looping;
 *   3. wait for that scroll to settle -- the scroller offsets and the
 *      element's own box stable across two consecutive animation frames, so a
 *      smooth scroll has landed and scroll-driven virtualization has finished
 *      re-laying out -- before the caller dispatches anything.
 *
 * The geometry lives here in Node so it is directly testable; the browser
 * halves are thin, self-contained measure and apply steps.
 *
 * Reveal is setup, not measurement. It scrolls programmatically, which fires no
 * pointerdown and no keydown, so it cannot start the trusted-action clock: that
 * clock still begins at the real pointerdown the harness dispatches afterwards.
 */

/** One axis of a box, in viewport coordinates. */
export type RevealSegment = { start: number; end: number }

/** The element measured against one scrollable ancestor, innermost first. */
export type RevealFrame = {
  element: { vertical: RevealSegment; horizontal: RevealSegment }
  view: { vertical: RevealSegment; horizontal: RevealSegment }
  scroll: { top: number; left: number }
  maxScroll: { top: number; left: number }
}

/** The single scroll to apply next, addressed by its index in the frame list. */
export type RevealStep = { depth: number; top: number; left: number }

/** Sub-pixel rects are normal; anything below this is already "fully in view". */
const REVEAL_EPSILON_PX = 0.5

/** How many measure/apply rounds a reveal may take before it is a failure. */
const REVEAL_ATTEMPT_LIMIT = 8

/**
 * `block: "nearest"` on one axis: zero when the element already fits inside the
 * view, otherwise the smaller of the two overflowing edges. An element larger
 * than the view can never fit, so its leading edge is aligned -- the nearest
 * reveal that is actually reachable.
 */
export function minimalRevealDelta(element: RevealSegment, view: RevealSegment): number {
  if (element.start >= view.start && element.end <= view.end) return 0
  if (element.end - element.start >= view.end - view.start) return element.start - view.start
  if (element.start < view.start) return element.start - view.start
  return element.end - view.end
}

/** A scroller cannot move past its own range; asking it to would never settle. */
function reachableDelta(delta: number, scroll: number, maxScroll: number) {
  return Math.max(-scroll, Math.min(delta, maxScroll - scroll))
}

/**
 * The next scroll a reveal should perform, or `undefined` when the element is
 * as visible as its scrollers can make it. Only the innermost frame that still
 * needs a reachable scroll is planned: moving it changes every outer frame's
 * geometry, so the caller re-measures and re-plans instead of guessing.
 */
export function revealScrollPlan(frames: readonly RevealFrame[]): RevealStep | undefined {
  for (let depth = 0; depth < frames.length; depth++) {
    const frame = frames[depth]!
    const top = reachableDelta(
      minimalRevealDelta(frame.element.vertical, frame.view.vertical),
      frame.scroll.top,
      frame.maxScroll.top,
    )
    const left = reachableDelta(
      minimalRevealDelta(frame.element.horizontal, frame.view.horizontal),
      frame.scroll.left,
      frame.maxScroll.left,
    )
    if (Math.abs(top) >= REVEAL_EPSILON_PX || Math.abs(left) >= REVEAL_EPSILON_PX) return { depth, top, left }
  }
  return undefined
}

/** The slice of the benchmark page a reveal needs. */
type RevealPage = {
  evaluate<R, A = undefined>(fn: ((arg: A) => R | Promise<R>) | (() => R | Promise<R>), arg?: A): Promise<R>
}

type RevealAddress = { selector: string; index: number }

/**
 * Measure the element against every scrollable ancestor, innermost first.
 *
 * Runs in the renderer as a stringified function, so it carries everything it
 * needs and shares no scope with this module.
 */
const measureRevealFrames = (input: RevealAddress): RevealFrame[] | null => {
  const element = document.querySelectorAll<HTMLElement>(input.selector)[input.index]
  if (!element) return null
  const box = element.getBoundingClientRect()
  // An unrendered element (a collapsed group's row, `display: none`) has no box
  // to reveal. Its empty rect sits at the origin, and chasing it would scroll
  // the list to the top for a row that can never become visible. Report nothing
  // to scroll and let the caller judge the element on its own merits.
  if (box.width <= 0 && box.height <= 0) return []
  const frames: RevealFrame[] = []
  for (let node: HTMLElement | null = element.parentElement; node; node = node.parentElement) {
    // The scrolling element scrolls the window, and does so regardless of what
    // its own computed overflow says.
    const root = node === document.scrollingElement
    const style = getComputedStyle(node)
    const scrollsVertically =
      node.scrollHeight - node.clientHeight > 1 && (root || /auto|scroll|overlay/u.test(style.overflowY))
    const scrollsHorizontally =
      node.scrollWidth - node.clientWidth > 1 && (root || /auto|scroll|overlay/u.test(style.overflowX))
    if (!scrollsVertically && !scrollsHorizontally) continue
    // The visible area is the padding box: inside the borders, excluding any
    // classic scrollbar gutter. That is exactly clientTop/clientLeft plus
    // clientHeight/clientWidth measured from the border box.
    const border = node.getBoundingClientRect()
    const view = root
      ? { top: 0, left: 0, height: innerHeight, width: innerWidth }
      : {
          top: border.top + node.clientTop,
          left: border.left + node.clientLeft,
          height: node.clientHeight,
          width: node.clientWidth,
        }
    frames.push({
      element: {
        vertical: { start: box.top, end: box.bottom },
        horizontal: { start: box.left, end: box.right },
      },
      view: {
        vertical: { start: view.top, end: view.top + view.height },
        horizontal: { start: view.left, end: view.left + view.width },
      },
      scroll: { top: node.scrollTop, left: node.scrollLeft },
      maxScroll: {
        top: scrollsVertically ? node.scrollHeight - node.clientHeight : 0,
        left: scrollsHorizontally ? node.scrollWidth - node.clientWidth : 0,
      },
    })
  }
  return frames
}

/**
 * Apply one planned scroll and resolve once it has settled.
 *
 * Settled means the scroller offsets and the element's own box are unchanged
 * across two consecutive animation frames: a smooth scroll has finished
 * animating and any virtualization the scroll triggered has finished mounting
 * and re-measuring rows.
 */
const applyRevealStep = (input: RevealAddress & RevealStep & { timeoutMs: number }) =>
  new Promise<void>((resolve, reject) => {
    const element = document.querySelectorAll<HTMLElement>(input.selector)[input.index]
    if (!element) {
      reject(new Error(`reveal target disappeared: ${input.selector}[${String(input.index)}]`))
      return
    }
    // Re-derive the scroller list exactly as the measurement did, so `depth`
    // still addresses the frame the plan was computed against.
    const scrollers: HTMLElement[] = []
    for (let node: HTMLElement | null = element.parentElement; node; node = node.parentElement) {
      const root = node === document.scrollingElement
      const style = getComputedStyle(node)
      const scrollsVertically =
        node.scrollHeight - node.clientHeight > 1 && (root || /auto|scroll|overlay/u.test(style.overflowY))
      const scrollsHorizontally =
        node.scrollWidth - node.clientWidth > 1 && (root || /auto|scroll|overlay/u.test(style.overflowX))
      if (scrollsVertically || scrollsHorizontally) scrollers.push(node)
    }
    const scroller = scrollers[input.depth]
    // Layout moved under the plan. Resolving lets the caller re-measure and
    // re-plan against what is actually on screen now.
    if (!scroller) {
      resolve()
      return
    }
    scroller.scrollTop += input.top
    scroller.scrollLeft += input.left
    const sample = () => {
      const current = document.querySelectorAll<HTMLElement>(input.selector)[input.index]
      const box = current?.getBoundingClientRect()
      return [
        Math.round(scroller.scrollTop * 100),
        Math.round(scroller.scrollLeft * 100),
        box ? Math.round(box.top * 100) : "detached",
        box ? Math.round(box.left * 100) : "detached",
        box ? Math.round(box.height * 100) : "detached",
      ].join("|")
    }
    const deadline = performance.now() + input.timeoutMs
    let previous: string | undefined
    let stableFrames = 0
    const frame = () => {
      const current = sample()
      stableFrames = current === previous ? stableFrames + 1 : 0
      previous = current
      if (stableFrames >= 2) {
        resolve()
        return
      }
      if (performance.now() >= deadline) {
        reject(new Error(`reveal scroll did not settle: ${input.selector}[${String(input.index)}] ${current}`))
        return
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })

/**
 * Bring `document.querySelectorAll(selector)[index]` into view the canonical
 * way and return once it is both revealed and settled.
 *
 * Returns without touching a single scroll offset when the element is already
 * fully visible -- the case that matters for an audit of an untouched sidebar.
 */
export async function revealElement(
  page: RevealPage,
  selector: string,
  index: number,
  settleTimeoutMs = 5_000,
): Promise<void> {
  for (let attempt = 0; attempt < REVEAL_ATTEMPT_LIMIT; attempt++) {
    const frames = await page.evaluate<RevealFrame[] | null, RevealAddress>(measureRevealFrames, { selector, index })
    if (!frames) throw new Error(`Claxedo reveal target is missing: ${selector}[${String(index)}]`)
    const step = revealScrollPlan(frames)
    if (!step) return
    await page.evaluate<void, RevealAddress & RevealStep & { timeoutMs: number }>(applyRevealStep, {
      selector,
      index,
      ...step,
      timeoutMs: settleTimeoutMs,
    })
  }
  throw new Error(`Claxedo reveal did not converge for ${selector}[${String(index)}]`)
}
