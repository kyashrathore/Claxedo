// ---------------------------------------------------------------------------
// Bezier edge rendering with theme-aware colours, flow animation, and
// highlight for edges connected to the currently selected node
// ---------------------------------------------------------------------------

import { createMemo } from "solid-js"
import type { OrchestratorNode, OrchestratorEdge, NodePos } from "./types"
import { edgePath } from "./layout"

interface CanvasEdgeProps {
  edge: OrchestratorEdge
  sourcePos: NodePos | undefined
  targetPos: NodePos | undefined
  sourceNode: OrchestratorNode | undefined
  nodeW: number
  nodeH: number
  selectedNodeId?: string | null
}

export function CanvasEdge(props: CanvasEdgeProps) {
  const d = createMemo(() => {
    const s = props.sourcePos
    const t = props.targetPos
    if (!s || !t) return ""
    return edgePath(s, t, props.nodeW, props.nodeH)
  })

  // Is this edge connected to the selected node?
  const isHighlighted = createMemo(() => {
    const sel = props.selectedNodeId
    if (!sel) return false
    return props.edge.source === sel || props.edge.target === sel
  })

  const stroke = createMemo(() => {
    if (isHighlighted()) return "var(--icon-interactive-base)"
    const src = props.sourceNode
    if (src?.status === "completed") return "var(--icon-success-base)"
    if (src?.status === "running") return "var(--icon-interactive-base)"
    return "var(--icon-weak-base)"
  })

  const strokeWidth = createMemo(() => (isHighlighted() ? 2.5 : 1.5))

  const opacity = createMemo(() => {
    if (isHighlighted()) return 1
    const src = props.sourceNode
    if (src?.status === "completed" || src?.status === "running") return 0.8
    return 0.5
  })

  const dasharray = createMemo(() => {
    const src = props.sourceNode
    return src?.status === "completed" ? "none" : "6 4"
  })

  const isFlowing = createMemo(() => props.sourceNode?.status === "running")

  return (
    <path
      d={d()}
      fill="none"
      stroke={stroke()}
      stroke-width={strokeWidth()}
      stroke-dasharray={dasharray()}
      opacity={opacity()}
      class={isFlowing() ? "oc-edge-flow" : undefined}
      style={{ transition: "stroke 0.2s, stroke-width 0.2s, opacity 0.2s" }}
    />
  )
}
