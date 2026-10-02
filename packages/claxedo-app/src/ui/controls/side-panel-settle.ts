import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

function transformMotions(element: HTMLElement): Animation[] {
  return element
    .getAnimations()
    .filter((animation) => animation instanceof CSSTransition && animation.transitionProperty === "transform")
}

export function createSidePanelSettle(
  element: () => HTMLElement | undefined,
  open: Accessor<boolean>,
): Accessor<boolean> {
  const [settled, setSettled] = createSignal(true)
  createEffect(
    on(
      open,
      () => {
        setSettled(false)
        let current = true
        const frame = requestAnimationFrame(() => {
          const shell = element()
          const motions = shell ? transformMotions(shell) : []
          void Promise.allSettled(motions.map((motion) => motion.finished)).then(() => {
            if (current) setSettled(true)
          })
        })
        onCleanup(() => {
          current = false
          cancelAnimationFrame(frame)
        })
      },
      { defer: true },
    ),
  )
  return settled
}
