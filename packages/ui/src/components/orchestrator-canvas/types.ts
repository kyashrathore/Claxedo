// ---------------------------------------------------------------------------
// Types and constants for the interactive orchestrator canvas
// ---------------------------------------------------------------------------

// Layout constants — inline (original compact view) and expanded (canvas view)
export const INLINE_NODE_W = 172
export const INLINE_NODE_H = 40
export const INLINE_LAYER_GAP = 60
export const INLINE_NODE_GAP = 20
export const INLINE_PAD = 20

export const EX_NODE_W = 280
export const EX_NODE_H = 80
export const EX_LAYER_GAP = 100
export const EX_NODE_GAP = 40
export const EX_PAD = 60

export interface OrchestratorNode {
  id: string
  title: string
  kind: string
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled"
  sessionID?: string
  agent: string
  error?: string
  prompt?: string
  lastMessage?: string
  result?: string
}

export type OrchestratorPhase = "planning" | "review" | "executing" | "paused" | "completed" | "failed" | "cancelled"

export interface OrchestratorMetadata {
  goal: string
  phase: OrchestratorPhase
  nodes: OrchestratorNode[]
  edges: OrchestratorEdge[]
  summary?: string
  paused?: boolean
  canSteer?: boolean
  questions?: string[]
  startTime?: number
  endTime?: number
}

export interface OrchestratorEdge {
  source: string
  target: string
}

export interface NodePos {
  x: number
  y: number
}

export interface LayoutConfig {
  nodeW: number
  nodeH: number
  layerGap: number
  nodeGap: number
  pad: number
}

export const INLINE_LAYOUT: LayoutConfig = {
  nodeW: INLINE_NODE_W,
  nodeH: INLINE_NODE_H,
  layerGap: INLINE_LAYER_GAP,
  nodeGap: INLINE_NODE_GAP,
  pad: INLINE_PAD,
}

export const EXPANDED_LAYOUT: LayoutConfig = {
  nodeW: EX_NODE_W,
  nodeH: EX_NODE_H,
  layerGap: EX_LAYER_GAP,
  nodeGap: EX_NODE_GAP,
  pad: EX_PAD,
}

export interface CanvasState {
  pan: { x: number; y: number }
  zoom: number
  mode: "idle" | "panning" | "dragging-node"
  selectedNodeId: string | null
  expandedNodeIds: string[]
  nodeOverrides: Record<string, { x: number; y: number }>
  paused: boolean
  animateTransform: boolean
  layoutVersion: number
}

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 3.0
export const ZOOM_STEP = 0.1

// Status colours — using CSS custom properties from the app theme.
// Uses the stronger/more visible variants so nodes and edges are
// clearly distinguishable in the graph canvas.
export const STATUS_COLORS = {
  pending: {
    fill: "var(--surface-raised-strong)",
    stroke: "var(--border-base)",
    text: "var(--text-base)",
    dot: "var(--icon-base)",
  },
  blocked: {
    fill: "var(--surface-raised-base)",
    stroke: "var(--border-weak-base)",
    text: "var(--text-weak)",
    dot: "var(--icon-weak-base)",
  },
  running: {
    fill: "var(--surface-interactive-base)",
    stroke: "var(--border-interactive-selected)",
    text: "var(--text-strong)",
    dot: "var(--icon-interactive-base)",
  },
  completed: {
    fill: "var(--surface-success-base)",
    stroke: "var(--border-success-selected)",
    text: "var(--text-base)",
    dot: "var(--icon-success-base)",
  },
  failed: {
    fill: "var(--surface-critical-base)",
    stroke: "var(--border-critical-selected)",
    text: "var(--text-base)",
    dot: "var(--icon-critical-base)",
  },
  cancelled: {
    fill: "var(--surface-warning-base)",
    stroke: "var(--border-warning-selected)",
    text: "var(--text-weak)",
    dot: "var(--icon-warning-base)",
  },
} as const

export const KIND_LABELS: Record<string, string> = {
  research: "research",
  code_gen: "code",
  review: "review",
  test: "test",
  docs: "docs",
  design: "design",
  deploy: "deploy",
}

export function statusColors(status: string) {
  return STATUS_COLORS[status as keyof typeof STATUS_COLORS] ?? STATUS_COLORS.pending
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s
}
