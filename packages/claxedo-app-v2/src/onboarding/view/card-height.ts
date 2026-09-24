const HEIGHT_TRANSITION = { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" } as const

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function animateHeightChanges(box: HTMLElement, content: readonly Element[]): () => void {
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
    if (Math.abs(from - target) < 1 || reducedMotion()) return
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
