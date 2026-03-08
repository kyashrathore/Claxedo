// ---------------------------------------------------------------------------
// DAG layout — topological sort + longest-path layer assignment +
// barycenter heuristic for edge-crossing minimisation.
// Parameterized to support both inline (compact) and expanded (canvas) views.
// ---------------------------------------------------------------------------

import type { OrchestratorNode, OrchestratorEdge, NodePos, LayoutConfig } from "./types"
import { INLINE_LAYOUT } from "./types"

export interface LayoutResult {
  positions: Map<string, NodePos>
  width: number
  height: number
}

/**
 * Lay out a DAG into horizontal layers (top to bottom).
 *
 * 1. Topological sort (Kahn's algorithm)
 * 2. Longest-path layer assignment
 * 3. Barycenter heuristic (6 sweeps up/down) to reduce edge crossings
 * 4. Center each layer horizontally, compute (x,y) per node
 * 5. Apply any user-drag overrides
 *
 * When layoutVersion > 0 (triggered by auto-arrange button), multiple
 * candidate orderings are tried and the one with fewest crossings wins.
 */
export function layoutDAG(
  nodes: OrchestratorNode[],
  edges: OrchestratorEdge[],
  config: LayoutConfig = INLINE_LAYOUT,
  _overrides?: Record<string, { x: number; y: number }>,
  layoutVersion?: number,
): LayoutResult {
  if (nodes.length === 0) return { positions: new Map(), width: 0, height: 0 }

  const { nodeW, nodeH, layerGap, nodeGap, pad } = config
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

  // ── Kahn's topological sort ─────────────────────────────────────────────
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

  // Handle cycles / orphans — append any unsorted nodes at the end
  for (const n of nodes) {
    if (!sorted.includes(n.id)) sorted.push(n.id)
  }

  // ── Longest-path layer assignment ───────────────────────────────────────
  const layers = new Map<string, number>()
  for (const id of sorted) {
    const pLayers = (parents.get(id) ?? []).map((p) => layers.get(p) ?? 0)
    layers.set(id, pLayers.length > 0 ? Math.max(...pLayers) + 1 : 0)
  }

  // Group by layer
  let maxLayer = 0
  const baseLayerGroups = new Map<number, string[]>()
  for (const [id, layer] of layers) {
    maxLayer = Math.max(maxLayer, layer)
    const group = baseLayerGroups.get(layer) ?? []
    group.push(id)
    baseLayerGroups.set(layer, group)
  }

  // ── Multi-candidate crossing minimisation ──────────────────────────────
  // Try multiple initial orderings and keep the one with fewest crossings.
  // The first candidate uses topo-sort order; others use reversed or
  // shuffled (seeded by layoutVersion) initial orderings.
  const candidates = (layoutVersion ?? 0) > 0 ? 4 : 1

  let bestLayerGroups: Map<number, string[]> | null = null
  let bestCrossings = Infinity

  for (let c = 0; c < candidates; c++) {
    // Deep-clone the base layer groups for this candidate
    const lg = new Map<number, string[]>()
    for (let l = 0; l <= maxLayer; l++) {
      const base = baseLayerGroups.get(l) ?? []
      const copy = [...base]
      // Candidate 0: original topo order
      // Candidate 1: reversed
      // Candidate 2+: seeded shuffle based on layoutVersion + candidate index
      if (c === 1) {
        copy.reverse()
      } else if (c >= 2) {
        // Simple deterministic shuffle using layoutVersion + candidate as seed
        const seed = ((layoutVersion ?? 0) * 7 + c * 13) | 0
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.abs((seed * (i + 1) * 2654435761) | 0) % (i + 1)
          const tmp = copy[i]
          copy[i] = copy[j]
          copy[j] = tmp
        }
      }
      lg.set(l, copy)
    }

    // Run barycenter sweeps on this candidate
    runBarycenterSweeps(lg, maxLayer, parents, children)

    // Count crossings
    const crossings = countCrossings(lg, maxLayer, edges, ids)
    if (crossings < bestCrossings) {
      bestCrossings = crossings
      bestLayerGroups = lg
    }

    // Perfect — no need to try more
    if (bestCrossings === 0) break
  }

  const layerGroups = bestLayerGroups!

  // ── Compute coordinates ─────────────────────────────────────────────────
  let maxRowWidth = 0
  for (let l = 0; l <= maxLayer; l++) {
    const g = layerGroups.get(l) ?? []
    const w = g.length * nodeW + (g.length - 1) * nodeGap
    maxRowWidth = Math.max(maxRowWidth, w)
  }

  const positions = new Map<string, NodePos>()
  for (let layer = 0; layer <= maxLayer; layer++) {
    const group = layerGroups.get(layer) ?? []
    const rowWidth = group.length * nodeW + (group.length - 1) * nodeGap
    const offsetX = (maxRowWidth - rowWidth) / 2
    group.forEach((id, i) => {
      positions.set(id, {
        x: pad + offsetX + i * (nodeW + nodeGap),
        y: pad + layer * (nodeH + layerGap),
      })
    })
  }

  const width = pad * 2 + maxRowWidth
  const height = pad * 2 + (maxLayer + 1) * nodeH + maxLayer * layerGap

  return { positions, width, height }
}

// ---------------------------------------------------------------------------
// Barycenter sweeps — reorder nodes within layers to minimise crossings
// ---------------------------------------------------------------------------

function runBarycenterSweeps(
  layerGroups: Map<number, string[]>,
  maxLayer: number,
  parents: Map<string, string[]>,
  children: Map<string, string[]>,
): void {
  const normalizedPos = new Map<string, number>()

  const updateNormalized = () => {
    for (let l = 0; l <= maxLayer; l++) {
      const group = layerGroups.get(l)!
      const len = group.length
      group.forEach((id, i) => {
        normalizedPos.set(id, len > 1 ? i / (len - 1) : 0.5)
      })
    }
  }

  updateNormalized()

  const SWEEPS = 6
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    // Top-down: order each layer by the average normalized position of ALL parents
    for (let l = 1; l <= maxLayer; l++) {
      const group = layerGroups.get(l)!
      group.sort((a, b) => {
        const ba = weightedBarycenter(a, parents, normalizedPos)
        const bb = weightedBarycenter(b, parents, normalizedPos)
        if (ba === -1 && bb === -1) return 0
        if (ba === -1) return 1
        if (bb === -1) return -1
        return ba - bb
      })
      layerGroups.set(l, group)
    }
    updateNormalized()

    // Bottom-up: order each layer by the average normalized position of ALL children
    for (let l = maxLayer - 1; l >= 0; l--) {
      const group = layerGroups.get(l)!
      group.sort((a, b) => {
        const ba = weightedBarycenter(a, children, normalizedPos)
        const bb = weightedBarycenter(b, children, normalizedPos)
        if (ba === -1 && bb === -1) return 0
        if (ba === -1) return 1
        if (bb === -1) return -1
        return ba - bb
      })
      layerGroups.set(l, group)
    }
    updateNormalized()
  }
}

// ---------------------------------------------------------------------------
// Count edge crossings for a given layer ordering
// ---------------------------------------------------------------------------

function countCrossings(
  layerGroups: Map<number, string[]>,
  maxLayer: number,
  edges: OrchestratorEdge[],
  ids: Set<string>,
): number {
  // Build position indices: nodeId → index within its layer
  const posIdx = new Map<string, number>()
  const layerOf = new Map<string, number>()
  for (let l = 0; l <= maxLayer; l++) {
    const group = layerGroups.get(l)!
    group.forEach((id, i) => {
      posIdx.set(id, i)
      layerOf.set(id, l)
    })
  }

  // Only count crossings between edges that share vertical overlap
  let crossings = 0
  const validEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))

  for (let i = 0; i < validEdges.length; i++) {
    for (let j = i + 1; j < validEdges.length; j++) {
      const a = validEdges[i]
      const b = validEdges[j]
      const asl = layerOf.get(a.source)!
      const atl = layerOf.get(a.target)!
      const bsl = layerOf.get(b.source)!
      const btl = layerOf.get(b.target)!

      // Check if vertical ranges overlap
      const aMin = Math.min(asl, atl)
      const aMax = Math.max(asl, atl)
      const bMin = Math.min(bsl, btl)
      const bMax = Math.max(bsl, btl)
      if (aMax <= bMin || bMax <= aMin) continue

      const asi = posIdx.get(a.source)!
      const ati = posIdx.get(a.target)!
      const bsi = posIdx.get(b.source)!
      const bti = posIdx.get(b.target)!

      // Edges cross if their source order differs from target order
      if ((asi - bsi) * (ati - bti) < 0) crossings++
    }
  }

  return crossings
}

// ---------------------------------------------------------------------------
// Weighted barycenter helper
// ---------------------------------------------------------------------------

/**
 * Returns the average normalized position (0..1) of a node's neighbours.
 * Returns -1 if the node has no connected neighbours.
 */
function weightedBarycenter(
  nodeId: string,
  adjacency: Map<string, string[]>,
  normalizedPos: Map<string, number>,
): number {
  const neighbours = adjacency.get(nodeId) ?? []
  if (neighbours.length === 0) return -1
  let sum = 0
  let count = 0
  for (const id of neighbours) {
    const pos = normalizedPos.get(id)
    if (pos !== undefined) {
      sum += pos
      count++
    }
  }
  return count > 0 ? sum / count : -1
}

/** Compute cubic bezier edge path from bottom-center of source to top-center of target */
export function edgePath(
  source: NodePos,
  target: NodePos,
  nodeW: number,
  nodeH: number,
): string {
  const x1 = source.x + nodeW / 2
  const y1 = source.y + nodeH
  const x2 = target.x + nodeW / 2
  const y2 = target.y
  const cy = (y1 + y2) / 2
  return `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`
}
