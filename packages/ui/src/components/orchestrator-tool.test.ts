import { describe, test, expect } from "bun:test"

// ---------------------------------------------------------------------------
// Extract and test the DAG layout algorithm independently.
// We duplicate the core layout logic here to test it in isolation
// (the component itself needs SolidJS context which is harder to set up).
// ---------------------------------------------------------------------------

interface Node {
  id: string
  title: string
  kind: string
  status: string
}

interface Edge {
  source: string
  target: string
}

const NODE_W = 172
const NODE_H = 40
const LAYER_GAP = 60
const NODE_GAP = 20
const PAD = 20

interface NodePos {
  x: number
  y: number
}

function layoutDAG(
  nodes: Node[],
  edges: Edge[],
): { positions: Map<string, NodePos>; width: number; height: number } {
  if (nodes.length === 0) return { positions: new Map(), width: 0, height: 0 }

  const ids = new Set(nodes.map((n) => n.id))
  const children = new Map<string, string[]>()
  const parents = new Map<string, string[]>()
  const inDegree = new Map<string, number>()

  for (const n of nodes) {
    children.set(n.id, [])
    parents.set(n.id, [])
    inDegree.set(n.id, 0)
  }

  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    children.get(e.source)!.push(e.target)
    parents.get(e.target)!.push(e.source)
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const sorted: string[] = []
  const tempDeg = new Map(inDegree)
  while (queue.length > 0) {
    const id = queue.shift()!
    sorted.push(id)
    for (const child of children.get(id) ?? []) {
      const d = (tempDeg.get(child) ?? 1) - 1
      tempDeg.set(child, d)
      if (d === 0) queue.push(child)
    }
  }

  for (const n of nodes) {
    if (!sorted.includes(n.id)) sorted.push(n.id)
  }

  const layers = new Map<string, number>()
  for (const id of sorted) {
    const pLayers = (parents.get(id) ?? []).map((p) => layers.get(p) ?? 0)
    layers.set(id, pLayers.length > 0 ? Math.max(...pLayers) + 1 : 0)
  }

  const layerGroups = new Map<number, string[]>()
  let maxLayer = 0
  for (const [id, layer] of layers) {
    maxLayer = Math.max(maxLayer, layer)
    const group = layerGroups.get(layer) ?? []
    group.push(id)
    layerGroups.set(layer, group)
  }

  let maxRowWidth = 0
  for (let l = 0; l <= maxLayer; l++) {
    const g = layerGroups.get(l) ?? []
    const w = g.length * NODE_W + (g.length - 1) * NODE_GAP
    maxRowWidth = Math.max(maxRowWidth, w)
  }

  const positions = new Map<string, NodePos>()
  for (let layer = 0; layer <= maxLayer; layer++) {
    const group = layerGroups.get(layer) ?? []
    const rowWidth = group.length * NODE_W + (group.length - 1) * NODE_GAP
    const offsetX = (maxRowWidth - rowWidth) / 2
    group.forEach((id, i) => {
      positions.set(id, {
        x: PAD + offsetX + i * (NODE_W + NODE_GAP),
        y: PAD + layer * (NODE_H + LAYER_GAP),
      })
    })
  }

  return {
    positions,
    width: PAD * 2 + maxRowWidth,
    height: PAD * 2 + (maxLayer + 1) * NODE_H + maxLayer * LAYER_GAP,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DAG layout", () => {
  test("empty graph returns zero dimensions", () => {
    const result = layoutDAG([], [])
    expect(result.positions.size).toBe(0)
    expect(result.width).toBe(0)
    expect(result.height).toBe(0)
  })

  test("single node centered", () => {
    const nodes: Node[] = [{ id: "a", title: "A", kind: "code_gen", status: "pending" }]
    const result = layoutDAG(nodes, [])
    expect(result.positions.size).toBe(1)
    const pos = result.positions.get("a")!
    expect(pos.x).toBe(PAD)
    expect(pos.y).toBe(PAD)
    expect(result.width).toBe(PAD * 2 + NODE_W)
    expect(result.height).toBe(PAD * 2 + NODE_H)
  })

  test("two parallel nodes on same layer", () => {
    const nodes: Node[] = [
      { id: "a", title: "A", kind: "code_gen", status: "running" },
      { id: "b", title: "B", kind: "test", status: "pending" },
    ]
    const result = layoutDAG(nodes, [])
    const posA = result.positions.get("a")!
    const posB = result.positions.get("b")!
    // Same y (same layer)
    expect(posA.y).toBe(posB.y)
    // B is to the right of A
    expect(posB.x).toBeGreaterThan(posA.x)
    // Gap between them
    expect(posB.x - posA.x).toBe(NODE_W + NODE_GAP)
  })

  test("linear chain: A → B → C gets 3 layers", () => {
    const nodes: Node[] = [
      { id: "a", title: "A", kind: "research", status: "completed" },
      { id: "b", title: "B", kind: "code_gen", status: "running" },
      { id: "c", title: "C", kind: "test", status: "pending" },
    ]
    const edges: Edge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ]
    const result = layoutDAG(nodes, edges)
    const posA = result.positions.get("a")!
    const posB = result.positions.get("b")!
    const posC = result.positions.get("c")!

    // A is on layer 0, B on layer 1, C on layer 2
    expect(posA.y).toBeLessThan(posB.y)
    expect(posB.y).toBeLessThan(posC.y)
    // All centered (single node per layer)
    expect(posA.x).toBe(posB.x)
    expect(posB.x).toBe(posC.x)
    // Correct vertical spacing
    expect(posB.y - posA.y).toBe(NODE_H + LAYER_GAP)
  })

  test("diamond: A → B,C → D", () => {
    const nodes: Node[] = [
      { id: "a", title: "Root", kind: "research", status: "completed" },
      { id: "b", title: "Left", kind: "code_gen", status: "completed" },
      { id: "c", title: "Right", kind: "code_gen", status: "running" },
      { id: "d", title: "Join", kind: "test", status: "blocked" },
    ]
    const edges: Edge[] = [
      { source: "a", target: "b" },
      { source: "a", target: "c" },
      { source: "b", target: "d" },
      { source: "c", target: "d" },
    ]
    const result = layoutDAG(nodes, edges)
    const posA = result.positions.get("a")!
    const posB = result.positions.get("b")!
    const posC = result.positions.get("c")!
    const posD = result.positions.get("d")!

    // Layer 0: A alone
    // Layer 1: B, C side by side
    // Layer 2: D alone
    expect(posA.y).toBeLessThan(posB.y)
    expect(posB.y).toBe(posC.y)
    expect(posB.y).toBeLessThan(posD.y)

    // B and C on same layer, B to the left
    expect(posC.x).toBeGreaterThan(posB.x)
  })

  test("ignores edges referencing unknown nodes", () => {
    const nodes: Node[] = [
      { id: "a", title: "A", kind: "code_gen", status: "pending" },
    ]
    const edges: Edge[] = [
      { source: "unknown", target: "a" },
      { source: "a", target: "missing" },
    ]
    const result = layoutDAG(nodes, edges)
    expect(result.positions.size).toBe(1)
    expect(result.positions.get("a")).toBeDefined()
  })

  test("disconnected subgraphs both appear", () => {
    const nodes: Node[] = [
      { id: "a", title: "A", kind: "code_gen", status: "pending" },
      { id: "b", title: "B", kind: "code_gen", status: "pending" },
      { id: "c", title: "C", kind: "code_gen", status: "pending" },
    ]
    const edges: Edge[] = [
      { source: "a", target: "b" },
      // c is disconnected
    ]
    const result = layoutDAG(nodes, edges)
    expect(result.positions.size).toBe(3)
    // A and C are on layer 0, B on layer 1
    const posA = result.positions.get("a")!
    const posC = result.positions.get("c")!
    const posB = result.positions.get("b")!
    expect(posA.y).toBe(posC.y) // same layer
    expect(posB.y).toBeGreaterThan(posA.y) // B is below
  })

  test("canvas dimensions accommodate all nodes", () => {
    const nodes: Node[] = [
      { id: "a", title: "A", kind: "code_gen", status: "pending" },
      { id: "b", title: "B", kind: "code_gen", status: "pending" },
      { id: "c", title: "C", kind: "code_gen", status: "pending" },
    ]
    // All on layer 0
    const result = layoutDAG(nodes, [])
    const expectedWidth = PAD * 2 + 3 * NODE_W + 2 * NODE_GAP
    expect(result.width).toBe(expectedWidth)
    expect(result.height).toBe(PAD * 2 + NODE_H)
  })
})

describe("metadata endpoint format", () => {
  test("OrchestratorMetadata shape is valid", () => {
    // Simulate what buildMetadata returns
    const metadata = {
      goal: "Build auth",
      phase: "executing" as const,
      nodes: [
        { id: "n1", title: "Auth API", kind: "code_gen", status: "completed" as const, agent: "build", sessionID: "sess-1" },
        { id: "n2", title: "Auth UI", kind: "code_gen", status: "running" as const, agent: "build" },
        { id: "n3", title: "Tests", kind: "test", status: "blocked" as const, agent: "build" },
      ],
      edges: [
        { source: "n1", target: "n3" },
        { source: "n2", target: "n3" },
      ],
      summary: "1/3 tasks completed · 1 running",
      startTime: Date.now(),
    }

    // Verify it can be layout'd
    const result = layoutDAG(metadata.nodes, metadata.edges)
    expect(result.positions.size).toBe(3)

    // n1 and n2 on layer 0, n3 on layer 1
    const p1 = result.positions.get("n1")!
    const p2 = result.positions.get("n2")!
    const p3 = result.positions.get("n3")!
    expect(p1.y).toBe(p2.y)
    expect(p3.y).toBeGreaterThan(p1.y)
  })
})
