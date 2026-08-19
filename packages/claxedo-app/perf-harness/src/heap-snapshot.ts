import { appendFile, rm } from "node:fs/promises"
import type { CDPSession } from "playwright-core"

/**
 * Heap-snapshot retainer analysis.
 *
 * Counters say a leak exists; only the object graph says WHO holds it. The
 * memory lane can see that thousands of DOM nodes are detached, and no counter
 * anywhere can name the reference keeping them alive — that answer is in the
 * edges, so this reads them.
 *
 * V8's snapshot marks detachedness on the node itself (0 unknown, 1 attached,
 * 2 detached), the same signal DevTools uses, so detached DOM is read from the
 * heap rather than inferred by diffing counts. The interesting object is then
 * not the detached node but its nearest ATTACHED retainer: the thing still
 * reachable from a root that is holding the corpse.
 */

export type RawSnapshot = {
  snapshot: {
    meta: {
      node_fields: string[]
      node_types: (string | string[])[]
      edge_fields: string[]
      edge_types: (string | string[])[]
    }
    node_count: number
    edge_count: number
  }
  nodes: number[]
  edges: number[]
  strings: string[]
}

/** Stream a snapshot to disk. It is far too large to hold as one string. */
export async function captureHeapSnapshot(cdp: CDPSession, file: string) {
  await rm(file, { force: true })
  let pending: Promise<void> = Promise.resolve()
  const onChunk = ({ chunk }: { chunk: string }) => {
    // Serialised: chunks arrive faster than the disk accepts them, and
    // interleaved writes corrupt the JSON in a way that only surfaces as a
    // parse error minutes later.
    pending = pending.then(() => appendFile(file, chunk))
  }
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
    await pending
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk)
  }
}

export type RetainerGroup = {
  /** The attached object holding detached DOM. */
  retainer: string
  /** The edge it holds them by — a property name, or an array index. */
  edge: string
  detachedNodes: number
  bytes: number
}

/**
 * Group detached DOM by what still points at it.
 *
 * Walks retainers rather than reporting the detached nodes themselves: a list
 * of thousands of HTMLDivElements names nothing, while "these are all held by
 * X's handlers array" is the defect. Only ATTACHED retainers count — a detached
 * node held by another detached node is part of the same corpse, not the
 * reference keeping it alive.
 */
export function analyzeDetachedRetainers(raw: RawSnapshot, limit = 15): RetainerGroup[] {
  const { node_fields, edge_fields, node_types, edge_types } = raw.snapshot.meta
  const nodeFieldCount = node_fields.length
  const edgeFieldCount = edge_fields.length
  const nameOffset = node_fields.indexOf("name")
  const typeOffset = node_fields.indexOf("type")
  const sizeOffset = node_fields.indexOf("self_size")
  const edgeCountOffset = node_fields.indexOf("edge_count")
  const detachOffset = node_fields.indexOf("detachedness")
  const edgeTypeOffset = edge_fields.indexOf("type")
  const edgeNameOffset = edge_fields.indexOf("name_or_index")
  const edgeToOffset = edge_fields.indexOf("to_node")
  const nodeTypeNames = (node_types[0] ?? []) as string[]
  const edgeTypeNames = (edge_types[0] ?? []) as string[]

  const nodeCount = raw.snapshot.node_count
  const nodeName = (index: number) => raw.strings[raw.nodes[index * nodeFieldCount + nameOffset]!] ?? "?"
  const nodeKind = (index: number) => nodeTypeNames[raw.nodes[index * nodeFieldCount + typeOffset]!] ?? "?"
  const detached = (index: number) =>
    detachOffset >= 0 && raw.nodes[index * nodeFieldCount + detachOffset] === 2

  // Edges are stored flat and consumed in node order, so a node's edge range is
  // the running total of every previous node's edge_count.
  const firstEdge = new Uint32Array(nodeCount + 1)
  for (let i = 0; i < nodeCount; i++) {
    firstEdge[i + 1] = firstEdge[i]! + raw.nodes[i * nodeFieldCount + edgeCountOffset]!
  }

  // A node's own retainer. Enough to climb toward a named owner without a full
  // reverse index, which for a snapshot this size would cost more memory than
  // the leak being investigated.
  //
  // Built in its OWN pass first: retainers are not ordered before the nodes
  // they retain, so filling this while grouping left every early node with an
  // empty retainer and the climb silently gave up at depth 0.
  const retainerOf = new Uint32Array(nodeCount)
  for (let source = 0; source < nodeCount; source++) {
    const start = firstEdge[source]!
    const end = firstEdge[source + 1]!
    for (let e = start; e < end; e++) {
      const target = raw.edges[e * edgeFieldCount + edgeToOffset]! / nodeFieldCount
      // Stored one-based: node index 0 is a real node, so a plain index would
      // make "retained by node 0" indistinguishable from "no retainer" and
      // stop every climb at its first step.
      if (!retainerOf[target]) retainerOf[target] = source + 1
    }
  }

  /**
   * Names that identify nothing. A leak reported as "an Array holds them" is
   * not a finding, so climb past these to whatever owns the container.
   */
  const generic = (name: string) =>
    name === "Object" || name === "Array" || name === "(object elements)" ||
    // A bound function is the mechanism, not the owner: `native_bind` held the
    // largest share of detached DOM here while naming nothing, because what
    // matters is which structure still stores the bound function.
    name === "native_bind" || name === "bound_this" ||
    name === "" || name.startsWith("system / ") || name.startsWith("(")

  const namedOwner = (start: number) => {
    let current = start
    for (let depth = 0; depth < 6; depth++) {
      const name = nodeName(current)
      if (!generic(name)) return { name, kind: nodeKind(current), depth }
      const next = retainerOf[current]
      if (!next || next - 1 === current) break
      current = next - 1
    }
    return { name: nodeName(start), kind: nodeKind(start), depth: 0 }
  }

  const groups = new Map<string, RetainerGroup>()
  // One pass over every edge: when an ATTACHED node points at a DETACHED one,
  // the source is what keeps it alive.
  for (let source = 0; source < nodeCount; source++) {
    if (detached(source)) continue
    const start = firstEdge[source]!
    const end = firstEdge[source + 1]!
    for (let e = start; e < end; e++) {
      const base = e * edgeFieldCount
      const target = raw.edges[base + edgeToOffset]! / nodeFieldCount
      if (!detached(target)) continue
      // Native DOM internals (SVGAnimatedLength, ShadowRoot, CSSStyleDeclaration)
      // are ATTRIBUTES of the detached node, not references keeping it alive.
      // They dominated the first version of this table and named nothing.
      if (nodeKind(source) === "native") continue
      const isIndexed = edgeTypeNames[raw.edges[base + edgeTypeOffset]!] === "element"
      const edgeLabel = isIndexed ? "[index]" : raw.strings[raw.edges[base + edgeNameOffset]!] ?? "?"
      const owner = namedOwner(source)
      const key = `${owner.kind} ${owner.name} ${edgeLabel}`
      const group = groups.get(key) ?? {
        retainer: `${owner.name} (${owner.kind})`,
        edge: edgeLabel,
        detachedNodes: 0,
        bytes: 0,
      }
      group.detachedNodes += 1
      group.bytes += raw.nodes[target * nodeFieldCount + sizeOffset]!
      groups.set(key, group)
    }
  }

  return [...groups.values()].sort((a, b) => b.detachedNodes - a.detachedNodes).slice(0, limit)
}

/** Total detached nodes in the snapshot, for cross-checking the DOM counters. */
export function countDetached(raw: RawSnapshot) {
  const nodeFieldCount = raw.snapshot.meta.node_fields.length
  const detachOffset = raw.snapshot.meta.node_fields.indexOf("detachedness")
  if (detachOffset < 0) return 0
  let total = 0
  for (let i = 0; i < raw.snapshot.node_count; i++) {
    if (raw.nodes[i * nodeFieldCount + detachOffset] === 2) total += 1
  }
  return total
}
