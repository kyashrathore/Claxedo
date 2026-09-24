import { prefersReducedMotion } from "@/ui/controls/reduced-motion"

/** The pace every height change in the app moves at. */
const HEIGHT_TRANSITION = { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" } as const

/**
 * Animate a box's height between the sizes its content gives it.
 *
 * A CSS transition cannot do this: the box's height stays `auto` while what
 * is inside it changes, and a keyword-to-keyword change interpolates nothing.
 * So the box is watched through its content: when a content element resizes,
 * layout has already put the box at its new height, and the box is animated
 * from the height it last settled at to the one it now has. A change landing
 * mid-animation starts from the height on screen at that moment.
 *
 * The box itself is observed too, so a change that is not the content's — a
 * window resize — updates the settled height without moving anything; while
 * an animation runs the box resizes every frame, and those reports are ignored.
 */
export function animateHeightChanges(box: HTMLElement, content: readonly Element[]) {
  if (typeof ResizeObserver === "undefined" || typeof box.animate !== "function") return () => {}
  let settled = box.getBoundingClientRect().height
  let running: Animation | undefined

  const observer = new ResizeObserver((entries) => {
    if (entries.every((entry) => entry.target === box)) {
      if (!running) settled = box.getBoundingClientRect().height
      return
    }
    const from = running ? box.getBoundingClientRect().height : settled
    running?.cancel()
    running = undefined
    const target = box.getBoundingClientRect().height
    settled = target
    if (Math.abs(from - target) < 1 || prefersReducedMotion()) return
    const animation = box.animate([{ height: `${from}px` }, { height: `${target}px` }], HEIGHT_TRANSITION)
    running = animation
    animation.addEventListener("finish", () => {
      if (running === animation) running = undefined
    })
  })
  observer.observe(box)
  for (const element of content) observer.observe(element)

  return () => {
    observer.disconnect()
    running?.cancel()
    running = undefined
  }
}
