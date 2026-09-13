/**
 * Whether an interaction belongs to an open popover, for a popover that
 * dismisses itself on pointerdown and focus rather than through the layer
 * stack of the library underneath.
 *
 * A control inside the popover — a select, a menu, a nested popover — opens
 * its layer in a portal at the body, so containment alone reads the first
 * focus into that layer as an escape. The layer mounts and takes focus
 * synchronously inside the pointerdown or keydown that opened it, and the
 * popover's window listeners run at capture, ahead of the control's own
 * handler: an interaction that began inside therefore marks the next outside
 * focus as an adoption, and the adopted layer counts as inside for as long as
 * it stays mounted.
 */
export type PopoverDismissalHost<N> = {
  /** Whether the popover's own content or trigger contains the node. */
  owns: (node: N) => boolean
  /** The portal root holding the node: its ancestor directly under the body. */
  portalRoot: (node: N) => N | undefined
  contains: (layer: N, node: N) => boolean
  isConnected: (layer: N) => boolean
}

export type PopoverDismissal<N> = {
  inside: (node: N) => boolean
  /** A pointerdown or a non-Escape keydown; returns whether it began inside. */
  beginInteraction: (target: N) => boolean
  /** The interaction's event has finished dispatching. */
  endInteraction: () => void
  /** What a focus landing on `target` means for the popover. */
  focusIn: (target: N) => "inside" | "adopted" | "outside"
}

export function createPopoverDismissal<N>(host: PopoverDismissalHost<N>): PopoverDismissal<N> {
  const adopted = new Set<N>()
  let interactingInside = false

  const inside = (node: N) => {
    if (host.owns(node)) return true
    for (const layer of adopted) {
      if (!host.isConnected(layer)) adopted.delete(layer)
      else if (host.contains(layer, node)) return true
    }
    return false
  }

  return {
    inside,
    beginInteraction: (target) => {
      interactingInside = inside(target)
      return interactingInside
    },
    endInteraction: () => {
      interactingInside = false
    },
    focusIn: (target) => {
      if (inside(target)) return "inside"
      if (!interactingInside) return "outside"
      const layer = host.portalRoot(target)
      if (!layer || host.owns(layer)) return "outside"
      adopted.add(layer)
      return "adopted"
    },
  }
}

/**
 * The container a portaled layer mounts in: the ancestor of `node` that is a
 * direct child of `body`. The body and the document element themselves are
 * not layers — a browser moves focus to the body when the focused element is
 * removed, and adopting the document would make every node "inside".
 */
export function portalRootUnder<N extends { parentElement: N | null }>(body: N, node: N): N | undefined {
  if (node === body || node.parentElement === null) return undefined
  let element = node
  while (element.parentElement && element.parentElement !== body) element = element.parentElement
  return element.parentElement === body ? element : undefined
}
