import { splitProps } from "solid-js"
import { spread } from "solid-js/web"

/**
 * A Kobalte part given this as its `as` renders onto an element that is
 * already drawn, so that element's children are never re-created and focus
 * inside them survives.
 */
export function adoptElement(target: () => HTMLElement | undefined) {
  return (props: Record<string, unknown>) => {
    const [, rest] = splitProps(props, ["children", "as"])
    const node = target()
    if (node) spread(node, rest, false, true)
    return undefined
  }
}
