type Snapshot = {
  snapshot: { meta: { node_fields: string[]; node_types: string[][]; edge_fields: string[]; edge_types: string[][] } }
  nodes: number[]
  edges: number[]
  strings: string[]
}

export type Retainer = { readonly name: string; readonly type: string; readonly edge: string }

type Graph = {
  readonly nodeCount: number
  readonly name: (node: number) => string
  readonly type: (node: number) => string
  readonly detached: (node: number) => boolean
  readonly selfSize: (node: number) => number
  readonly retainers: (node: number) => readonly { from: number; edge: string }[]
}

export function loadGraph(raw: Snapshot): Graph {
  const { snapshot, nodes, edges, strings } = raw
  const nodeFields = snapshot.meta.node_fields
  const edgeFields = snapshot.meta.edge_fields
  const nodeTypes = snapshot.meta.node_types[0] ?? []
  const edgeTypes = snapshot.meta.edge_types[0] ?? []
  const width = nodeFields.length
  const edgeWidth = edgeFields.length
  const field = (name: string) => nodeFields.indexOf(name)
  const iType = field("type")
  const iName = field("name")
  const iSize = field("self_size")
  const iEdges = field("edge_count")
  const iDetached = field("detachedness")
  const eType = edgeFields.indexOf("type")
  const eName = edgeFields.indexOf("name_or_index")
  const eTo = edgeFields.indexOf("to_node")
  const nodeCount = nodes.length / width
  const inCount = new Uint32Array(nodeCount + 1)
  let edgeIndex = 0
  for (let node = 0; node < nodeCount; node += 1) {
    const end = edgeIndex + nodes[node * width + iEdges]! * edgeWidth
    for (; edgeIndex < end; edgeIndex += edgeWidth) {
      if (edgeTypes[edges[edgeIndex + eType]!] === "weak") continue
      inCount[edges[edgeIndex + eTo]! / width + 1] += 1
    }
  }
  for (let node = 0; node < nodeCount; node += 1) inCount[node + 1]! += inCount[node]!
  const inFrom = new Uint32Array(inCount[nodeCount]!)
  const inEdge = new Uint32Array(inCount[nodeCount]!)
  const fill = inCount.slice()
  edgeIndex = 0
  for (let node = 0; node < nodeCount; node += 1) {
    const end = edgeIndex + nodes[node * width + iEdges]! * edgeWidth
    for (; edgeIndex < end; edgeIndex += edgeWidth) {
      if (edgeTypes[edges[edgeIndex + eType]!] === "weak") continue
      const to = edges[edgeIndex + eTo]! / width
      inFrom[fill[to]!] = node
      inEdge[fill[to]!] = edgeIndex
      fill[to]! += 1
    }
  }
  const edgeLabel = (index: number) => {
    const type = edgeTypes[edges[index + eType]!] ?? "?"
    const nameOrIndex = edges[index + eName]!
    const name = type === "element" || type === "hidden" ? String(nameOrIndex) : strings[nameOrIndex] ?? "?"
    return `${type}:${name}`
  }
  return {
    nodeCount,
    name: (node) => strings[nodes[node * width + iName]!] ?? "?",
    type: (node) => nodeTypes[nodes[node * width + iType]!] ?? "?",
    detached: (node) => (iDetached >= 0 && nodes[node * width + iDetached] === 2) || (strings[nodes[node * width + iName]!] ?? "").startsWith("Detached "),
    selfSize: (node) => nodes[node * width + iSize]!,
    retainers: (node) => {
      const out: { from: number; edge: string }[] = []
      for (let at = inCount[node]!; at < inCount[node + 1]!; at += 1) out.push({ from: inFrom[at]!, edge: edgeLabel(inEdge[at]!) })
      return out
    },
  }
}

const DOM_NAME = /^(Detached )?(HTML\w*Element|SVG\w*Element|Text|Comment|DocumentFragment|Element|Node)$/

export function shortestPath(graph: Graph, start: number, limit = 40): Retainer[] {
  const previous = new Map<number, { from: number; edge: string }>()
  const seen = new Set<number>([start])
  let frontier = [start]
  for (let depth = 0; depth < limit && frontier.length; depth += 1) {
    const next: number[] = []
    for (const node of frontier) {
      if (graph.type(node) === "synthetic" && node !== start) return unwind(graph, previous, node)
      for (const { from, edge } of graph.retainers(node)) {
        if (seen.has(from)) continue
        seen.add(from)
        previous.set(from, { from: node, edge })
        next.push(from)
      }
    }
    frontier = next
  }
  return []
}

function unwind(graph: Graph, previous: Map<number, { from: number; edge: string }>, root: number): Retainer[] {
  const path: Retainer[] = []
  let node: number | undefined = root
  while (node !== undefined) {
    const step = previous.get(node)
    path.push({ name: graph.name(node), type: graph.type(node), edge: step?.edge ?? "" })
    node = step?.from
  }
  return path.reverse()
}

export function firstOwner(path: readonly Retainer[]): string {
  const owner = path.find((step) => !DOM_NAME.test(step.name))
  return owner ? `${owner.type} ${owner.name} via ${owner.edge}` : "(none)"
}

export function detachedNodes(graph: Graph): number[] {
  const out: number[] = []
  for (let node = 0; node < graph.nodeCount; node += 1) if (graph.detached(node)) out.push(node)
  return out
}

export function tally(entries: readonly string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}
