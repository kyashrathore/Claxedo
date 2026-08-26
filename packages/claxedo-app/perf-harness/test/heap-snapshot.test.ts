import { describe, expect, test } from "bun:test"
import { analyzeDetachedRetainers, countDetached, type RawSnapshot } from "../src/heap-snapshot"

/**
 * A hand-built snapshot in V8's real layout: flat node and edge arrays indexed
 * by field offsets, with `to_node` an OFFSET into `nodes` rather than a node
 * ordinal. Getting that offset convention wrong silently mis-attributes every
 * retainer, so it is pinned here rather than trusted.
 */
const NODE_FIELDS = ["type", "name", "id", "self_size", "edge_count", "detachedness"]
const EDGE_FIELDS = ["type", "name_or_index", "to_node"]
const NODE_TYPES = ["hidden", "object", "closure", "native"]
const EDGE_TYPES = ["context", "element", "property"]

type NodeSpec = { type: number; name: number; size: number; detached: 0 | 1 | 2; edges: EdgeSpec[] }
type EdgeSpec = { type: number; name: number; to: number }

function snapshot(nodes: NodeSpec[], strings: string[]): RawSnapshot {
  const flatNodes: number[] = []
  const flatEdges: number[] = []
  nodes.forEach((node, index) => {
    flatNodes.push(node.type, node.name, index + 1, node.size, node.edges.length, node.detached)
  })
  for (const node of nodes) {
    for (const edge of node.edges) flatEdges.push(edge.type, edge.name, edge.to * NODE_FIELDS.length)
  }
  return {
    snapshot: {
      meta: {
        node_fields: NODE_FIELDS, node_types: [NODE_TYPES, "string", "number", "number", "number", "number"],
        edge_fields: EDGE_FIELDS, edge_types: [EDGE_TYPES, "string_or_number", "node"],
      },
      node_count: nodes.length,
      edge_count: flatEdges.length / EDGE_FIELDS.length,
    },
    nodes: flatNodes,
    edges: flatEdges,
    strings,
  }
}

describe("detached retainer analysis", () => {
  test("counts detached nodes from the heap's own flag", () => {
    // detachedness: 0 unknown, 1 attached, 2 detached. Only 2 is detached —
    // treating "unknown" as detached would report most of the DOM as leaked.
    const raw = snapshot([
      { type: 1, name: 0, size: 10, detached: 1, edges: [] },
      { type: 3, name: 1, size: 20, detached: 2, edges: [] },
      { type: 3, name: 1, size: 20, detached: 0, edges: [] },
    ], ["Window", "HTMLDivElement"])
    expect(countDetached(raw)).toBe(1)
  })

  test("reports snapshots without a detachedness field as unsupported", () => {
    const raw = snapshot([
      { type: 3, name: 0, size: 10, detached: 2, edges: [] },
    ], ["HTMLDivElement"])
    raw.snapshot.meta.node_fields = raw.snapshot.meta.node_fields.filter((field) => field !== "detachedness")
    expect(countDetached(raw)).toBeUndefined()
  })

  test("names the attached holder, not the detached node", () => {
    // 0: a SessionCache (attached) holding 1: a detached div by property "row".
    const raw = snapshot([
      { type: 1, name: 0, size: 32, detached: 1, edges: [{ type: 2, name: 2, to: 1 }] },
      { type: 3, name: 1, size: 64, detached: 2, edges: [] },
    ], ["SessionCache", "HTMLDivElement", "row"])
    const [group] = analyzeDetachedRetainers(raw)
    expect(group.retainer).toBe("SessionCache (object)")
    expect(group.edge).toBe("row")
    expect(group.detachedNodes).toBe(1)
    expect(group.bytes).toBe(64)
  })

  test("ignores native DOM internals, which are attributes not holders", () => {
    // A CSSStyleDeclaration pointing at its own detached element is part of the
    // corpse. Counting it drowned the real holders in the first version.
    const raw = snapshot([
      { type: 3, name: 2, size: 16, detached: 1, edges: [{ type: 1, name: 0, to: 1 }] },
      { type: 3, name: 1, size: 64, detached: 2, edges: [] },
    ], ["", "HTMLDivElement", "CSSStyleDeclaration"])
    expect(analyzeDetachedRetainers(raw)).toEqual([])
  })

  test("climbs past containers that name nothing", () => {
    // 0: TimelineStore -> 1: Array -> 2: detached div. Reporting "an Array
    // holds them" is not a finding; the owning structure is.
    const raw = snapshot([
      { type: 1, name: 0, size: 32, detached: 1, edges: [{ type: 2, name: 3, to: 1 }] },
      { type: 1, name: 1, size: 32, detached: 1, edges: [{ type: 1, name: 0, to: 2 }] },
      { type: 3, name: 2, size: 64, detached: 2, edges: [] },
    ], ["TimelineStore", "Array", "HTMLDivElement", "rows"])
    const [group] = analyzeDetachedRetainers(raw)
    expect(group.retainer).toBe("TimelineStore (object)")
  })

  test("a detached node held only by another detached node has no holder", () => {
    // Both are corpses; neither is the reference keeping the pair alive.
    const raw = snapshot([
      { type: 3, name: 1, size: 32, detached: 2, edges: [{ type: 2, name: 2, to: 1 }] },
      { type: 3, name: 1, size: 64, detached: 2, edges: [] },
    ], ["", "HTMLDivElement", "child"])
    expect(analyzeDetachedRetainers(raw)).toEqual([])
  })
})
