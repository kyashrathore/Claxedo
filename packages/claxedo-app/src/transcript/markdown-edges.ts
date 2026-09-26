const EDGE = "data-markdown-edge"

export function keepMarkdownEdge(from: Element, to: Element) {
  const edge = from.getAttribute(EDGE)
  if (edge !== null) to.setAttribute(EDGE, edge)
}

function edgesOf(container: Element): Map<Element, string> {
  const edges = new Map<Element, string>()
  const add = (element: Element | null | undefined, edge: "first" | "last") => {
    if (element) edges.set(element, edges.has(element) ? `${edges.get(element)} ${edge}` : edge)
  }
  add(container.firstElementChild?.firstElementChild, "first")
  add(container.lastElementChild?.lastElementChild, "last")
  return edges
}

export function createMarkdownEdges() {
  let marked = new Map<Element, string>()
  return {
    mark: (container: Element) => {
      const next = edgesOf(container)
      for (const element of marked.keys()) if (!next.has(element)) element.removeAttribute(EDGE)
      for (const [element, edge] of next) if (element.getAttribute(EDGE) !== edge) element.setAttribute(EDGE, edge)
      marked = next
    },
  }
}
