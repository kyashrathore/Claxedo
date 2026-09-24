import { makeEventListener } from "@solid-primitives/event-listener"

export type PopoverDismissalHost<N> = {
  owns: (node: N) => boolean
  portalRoot: (node: N) => N | undefined
  contains: (layer: N, node: N) => boolean
  isConnected: (layer: N) => boolean
}

export type PopoverDismissal<N> = {
  inside: (node: N) => boolean
  beginInteraction: (target: N) => boolean
  endInteraction: () => void
  focusIn: (target: N) => "inside" | "adopted" | "outside"
}

export function createPopoverDismissal<N>(host: PopoverDismissalHost<N>): PopoverDismissal<N> {
  const adopted = new Set<N>()
  const interaction = { inside: false }

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
      interaction.inside = inside(target)
      return interaction.inside
    },
    endInteraction: () => {
      interaction.inside = false
    },
    focusIn: (target) => {
      if (inside(target)) return "inside"
      if (!interaction.inside) return "outside"
      const layer = host.portalRoot(target)
      if (!layer || host.owns(layer)) return "outside"
      adopted.add(layer)
      return "adopted"
    },
  }
}

export function portalRootUnder<N extends { parentElement: N | null }>(body: N, node: N): N | undefined {
  if (node === body || node.parentElement === null) return undefined
  let element = node
  while (element.parentElement && element.parentElement !== body) element = element.parentElement
  return element.parentElement === body ? element : undefined
}

export type DismissReason = "escape" | "outside"

export function listenForDismissal(input: { owns: (node: Node) => boolean; close: (reason: DismissReason) => void }) {
  const dismissal = createPopoverDismissal<Node>({
    owns: input.owns,
    portalRoot: (node) => portalRootUnder(document.body, node),
    contains: (layer, node) => layer.contains(node),
    isConnected: (layer) => layer.isConnected,
  })

  const beginInteraction = (target: Node) => {
    dismissal.beginInteraction(target)
    setTimeout(dismissal.endInteraction, 0)
  }

  makeEventListener(
    window,
    "keydown",
    (event) => {
      if (event.key !== "Escape") {
        if (event.target instanceof Node) beginInteraction(event.target)
        return
      }
      input.close("escape")
      event.preventDefault()
      event.stopPropagation()
    },
    { capture: true },
  )

  makeEventListener(
    window,
    "pointerdown",
    (event) => {
      if (!(event.target instanceof Node)) return
      if (dismissal.inside(event.target)) return beginInteraction(event.target)
      input.close("outside")
    },
    { capture: true },
  )

  makeEventListener(
    window,
    "focusin",
    (event) => {
      if (!(event.target instanceof Node)) return
      if (dismissal.focusIn(event.target) === "outside") input.close("outside")
    },
    { capture: true },
  )
}
