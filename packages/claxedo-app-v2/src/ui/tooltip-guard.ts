import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

type Trigger = () => HTMLDivElement | undefined

const focusInside = (element: HTMLDivElement | undefined) =>
  !!element && !!document.activeElement && element.contains(document.activeElement)

const hasExpandedPopup = (element: HTMLDivElement | undefined) =>
  !!element?.querySelector('[aria-expanded="true"], [data-expanded]')

function watchPopups(trigger: Trigger, sync: () => void) {
  createEffect(() => {
    const element = trigger()
    if (!element) return
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-expanded", "data-expanded"] })
    onCleanup(() => observer.disconnect())
  })
}

function createClickArming(trigger: Trigger) {
  let armed = false
  return {
    pointerDownOutside: (target: EventTarget | null) => {
      const element = trigger()
      if (element === target || (target instanceof Node && element?.contains(target))) armed = true
    },
    consume: () => {
      if (!armed) return false
      armed = false
      return true
    },
  }
}

export function createTooltipGuard(trigger: Trigger) {
  const [state, setState] = createStore({ open: false, block: false, expand: false })
  const close = () => setState("open", false)

  const release = (expand = state.expand) => {
    if (expand || trigger()?.matches(":hover") || focusInside(trigger())) return
    setState("block", false)
  }

  const sync = () => {
    const expand = hasExpandedPopup(trigger())
    setState("expand", expand)
    if (!expand) return release(expand)
    setState("block", true)
    close()
  }

  watchPopups(trigger, sync)
  const click = createClickArming(trigger)

  return {
    open: () => state.open,
    arm: () => {
      setState("block", true)
      close()
    },
    leave: () => {
      if (!focusInside(trigger())) close()
      release()
    },
    release: () => release(),
    change: (open: boolean) => {
      if ((state.block && open) || click.consume()) return
      setState("open", open)
    },
    pointerDownOutside: click.pointerDownOutside,
  }
}
