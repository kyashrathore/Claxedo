import type { AgentEventEnvelope, AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"

export type PresentationProjection = { ingest: (event: AgentRuntimeEvent) => AgentEventEnvelope[] }

export type CreatePresentationProjection = (options: {
  sessionId: string
  directory: string
  assistantMessageId: string
  clock?: () => number
}) => PresentationProjection
