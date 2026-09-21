import type { ExecutionAvailability } from "./availability"
import type { AgentAgentPartInput, AgentFilePartInput, AgentTextPartInput } from "./content"

export type AgentWorkspaceIdentity = {
  workspaceId: string
  directory: string
}

/**
 * The complete identity required for any provider-owned execution operation.
 * `upstreamSessionId` is opaque: Claxedo stores and forwards it but never
 * parses it or uses it to discover sessions.
 */
export type AgentWorkspaceExecutionBinding = AgentWorkspaceIdentity & {
  scope?: "workspace"
  sessionId: string
  connectionId: string
  upstreamSessionId: string
}

export type AgentExecutionBinding = AgentWorkspaceExecutionBinding

/** Ownership of creation before the provider has returned any session identity. */
export type AgentSessionStartBinding = AgentWorkspaceIdentity & {
  sessionId: string
  connectionId: string
  operationId: string
}

export type AgentSessionStart = {
  binding: AgentSessionStartBinding
  createdAt: number
  updatedAt: number
} & (
  | { status: "starting" }
  | { status: "created"; upstreamSessionId: string }
  | { status: "failed"; error: string }
)

export interface AgentSessionStarts {
  get(sessionId: string): AgentSessionStart | undefined
  begin(binding: AgentSessionStartBinding): AgentSessionStart
  finish(binding: AgentSessionStartBinding, outcome: { status: "created"; upstreamSessionId: string } | { status: "failed"; error: string }): AgentSessionStart
  /**
   * Gives the id back after an authorized deletion has already removed the
   * provider session. Every binding field must still match, so an operation
   * that read the record before a newer one took the id cannot retire it.
   * Answers whether this call removed the record.
   */
  retire(binding: AgentSessionStartBinding): boolean
}

export type AgentExecutionBindingField = keyof AgentExecutionBinding

export type AgentExecutionBindingExpectation = Readonly<{
  scope?: "workspace"
  sessionId: string
  workspaceId?: string
  directory: string
  connectionId: string
  upstreamSessionId: string
}>

/**
 * Who wrote the current title, ranked: a user rename beats a harness or
 * model-generated title, which beats the first-prompt placeholder. A writer of
 * lower rank than the stored one is dropped by the store.
 */
export type AgentSessionTitleSource = "prompt" | "harness" | "user"

/** Commands advertised by this agent session; invoked as slash-prefixed prompts. */
export type AgentSessionCommand = {
  name: string
  description: string
  input?: { hint: string } | null
}

export type AgentSession = {
  id: string
  workspaceId?: string
  title?: string | null
  titleSource?: AgentSessionTitleSource
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
  commands?: AgentSessionCommand[]
}

export type AgentPresentationSession = AgentSession & {
  tags?: string[]
  slug: string
  projectID: string
  workspaceID?: string
  directory: string
  path?: string
  parentID?: string
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: import("./content").AgentSnapshotFileDiff[]
  }
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  share?: { url: string }
  title: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  version: string
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
  time: { created: number; updated: number; archived?: number }
}

export type AgentTurnOutcome = (
  | { status: "completed"; completedAt: number; reason?: string }
  | { status: "failed"; completedAt: number; error: string }
  | { status: "cancelled"; completedAt: number; reason?: string }
) & { assistantMessageId?: string }

export type PromptModel = {
  providerID: string
  modelID: string
}

export type PromptFormat =
  | { type: "json_schema"; name?: string; schema?: unknown; strict?: boolean; provider_payload?: unknown }
  | { type: string; provider_payload?: unknown; [key: string]: unknown }

export type PromptInput = {
  parts: Array<AgentTextPartInput | AgentFilePartInput | AgentAgentPartInput>
  userMessageId?: string
  /** Existing user intent that owns a provider-initiated continuation. */
  parentMessageId?: string
  assistantMessageId: string
  agent: string
  model?: PromptModel
  tools?: Record<string, boolean>
  format?: PromptFormat
  system?: string
  variant?: string
  permissionMode?: string
  /**
   * What to do when the session is already running a turn. `steer` hands this
   * prompt to that turn; `queue` holds it for the next one. Absent means the
   * caller wants a turn of its own and will take an admission conflict.
   */
  delivery?: PromptDeliveryRequest
  author?: AgentMessageAuthor
}

export type PromptDeliveryRequest = "steer" | "queue"

/** How a prompt was admitted. `start` ran it as a turn of its own. */
export type PromptDelivery = "start" | PromptDeliveryRequest

export type AgentMessageAuthor = {
  id: string
  name: string
  avatarUrl?: string
  kind: "human" | "agent"
}

export function connectionIdForHarness(harness: { id: string; access: string }): string {
  return `${harness.access}:${harness.id}`
}
