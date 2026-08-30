import type { ExecutionAvailability } from "./availability"

export type AgentWorkspaceIdentity = {
  workspaceId: string
  directory: string
}

/**
 * The complete identity required for any provider-owned execution operation.
 * `upstreamSessionId` is opaque: Claxedo stores and forwards it but never
 * parses it or uses it to discover sessions.
 */
export type AgentExecutionBinding = AgentWorkspaceIdentity & {
  sessionId: string
  connectionId: string
  upstreamSessionId: string
}

export type AgentExecutionBindingField = keyof AgentExecutionBinding

export type AgentExecutionBindingExpectation = Readonly<AgentExecutionBinding>

export type AgentSession = {
  id: string
  workspaceId?: string
  title?: string | null
  slug?: string
  version?: string
  directory?: string
  parentID?: string
  rootID?: string
  projectID?: string
  tags?: unknown[]
  attachments?: unknown[]
  metadata?: Record<string, unknown>
  time?: { created: number; updated?: number; archived?: number }
  status?: string | null
  lastTurn?: AgentTurnOutcome
  executionAvailability?: ExecutionAvailability
  harnessPayload?: unknown
}

export type AgentPresentationSession = AgentSession & {
  directory: string
  title: string
  version: string
  time: { created: number; updated: number; archived?: number }
}

export type AgentTurnOutcome = (
  | { status: "completed"; completedAt: number; reason?: string }
  | { status: "failed"; completedAt: number; error: string }
  | { status: "cancelled"; completedAt: number; reason?: string }
) & { assistantMessageId?: string }

export type AgentPageRequest = {
  limit: number
  cursor?: string
}

export type AgentPage<T> = {
  items: T[]
  nextCursor?: string
}

export type PromptModel = {
  providerID: string
  modelID: string
}

export type PromptFormat =
  | { type: "json_schema"; name?: string; schema?: unknown; strict?: boolean; provider_payload?: unknown }
  | { type: string; provider_payload?: unknown; [key: string]: unknown }

export type PromptInput = {
  parts: unknown[]
  userMessageId?: string
  assistantMessageId: string
  agent: string
  model: PromptModel
  tools?: Record<string, boolean>
  format?: PromptFormat
  system?: string
  variant?: string
  permissionMode?: string
  author?: AgentMessageAuthor
}

export type AgentMessageAuthor = {
  id: string
  name: string
  avatarUrl?: string
  kind: "human" | "agent"
}

export function connectionIdForHarness(harness: { id: string; access: string }): string {
  return `${harness.access}:${harness.id}`
}
