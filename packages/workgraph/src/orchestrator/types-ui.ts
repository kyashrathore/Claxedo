/**
 * Types for the orchestrator tool UI metadata.
 * These are the shapes sent in ToolPart.state.metadata
 * and consumed by the OrchestratorTool frontend component.
 */

export interface OrchestratorMetadata {
  goal: string
  phase: "planning" | "executing" | "completed" | "failed"
  nodes: OrchestratorNodeUI[]
  edges: OrchestratorEdgeUI[]
  summary?: string
  paused?: boolean
  canSteer?: boolean
  startTime: number
  endTime?: number
}

export interface OrchestratorNodeUI {
  id: string
  title: string
  kind: string
  status: "pending" | "running" | "completed" | "failed" | "blocked"
  sessionID?: string
  agent: string
  error?: string
  prompt?: string
  lastMessage?: string
  startTime?: number
  endTime?: number
}

export interface OrchestratorEdgeUI {
  source: string
  target: string
}
