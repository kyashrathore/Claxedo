import type { SessionHarness } from "./harnesses"
import type { SessionModelGroup } from "./session-group"
import type { AutoLevel } from "./permissions"
import type { CleanupFact, ExecutionFact } from "./recovery/facts"
import type { RecoveryErrorCode } from "./recovery/operations"
import type { ExecutionAvailability } from "./availability"
import type { AgentAgentPartInput, AgentFilePartInput, AgentTextPartInput } from "./content"
import type { FirstTurnErrorClass } from "./turn-error-classes"
import type { TurnAccount } from "./turn-account"

export type SessionRef = Readonly<{ sessionId: string; workspaceId: string }>

export type AgentWorkspaceIdentity = {
  workspaceId: string
  directory: string
}

/**
 * The complete identity required for any provider-owned execution operation.
 * `upstreamSessionId` is opaque: Claxedo stores and forwards it but never
 * parses it or uses it to discover sessions.
 */
export type AgentWorkspaceExecutionBinding = AgentWorkspaceIdentity & SessionRef & {
  scope?: "workspace"
  connectionId: string
  upstreamSessionId: string
}

export type AgentExecutionBinding = AgentWorkspaceExecutionBinding

/** Ownership of creation before the provider has returned any session identity. */
export type AgentSessionStartBinding = AgentWorkspaceIdentity & SessionRef & {
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
  /** `detail` is what the harness's transport established about the failure, carried onto the turn's error record. */
  | { status: "failed"; completedAt: number; error: string; errorClass?: FirstTurnErrorClass; account?: TurnAccount; detail?: Readonly<Record<string, string>> }
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
  /**
   * A faster tier the selected model advertises (Codex `priority`, "Fast").
   * Absent runs the standard tier; a harness drops a tier the model lacks.
   */
  serviceTier?: string
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

/**
 * Conversation context owed to a session's fresh native thread, carried on
 * every turn until one completes. `announced` records that the harness change
 * was written onto a sent user message, so a retried first turn does not mark
 * it again.
 */
export type SessionHandoff = {
  from: SessionHarness
  pending: true
  transcript: string
  announced?: true
  source?: SessionHandoffSource
}

/**
 * The native session of the harness a handoff left, and the config it ran
 * under. It is kept until a message is sent on the new harness, so picking the
 * left harness back resumes its own thread instead of a transcript copy.
 */
export type SessionHandoffSource = {
  agentSessionId: string
  upstreamSessionId: string
  ownerKey: string | null
  model?: PromptModel
  variant?: string | null
  agent?: string | null
  handoff?: Omit<SessionHandoff, "source">
}

export type SessionConfig = {
  /** Host-owned maximum permission level, retained across harness changes. */
  permissionCeiling?: AutoLevel
  /** Accepted harness mode, persisted by the permission-mode operation. */
  permissionMode?: string
  /**
   * The accepted mode's name as the agent listed it when the mode was stored.
   * Only a harness whose modes the runtime contract does not declare has one,
   * so a client can name the mode without asking the agent for its list.
   */
  permissionModeLabel?: string
  /** Native permission state accepted by the driver; opaque to shared consumers. */
  permissionState?: Record<string, unknown>
  harness: SessionHarness
  model?: PromptModel
  variant?: string | null
  agent?: string | null
  /**
   * Standing instructions this session was created with. Retained so a session
   * reopened after a restart keeps them without the caller resending anything;
   * where they reach the harness is that harness's own `instructionChannel`,
   * and one with none refuses the create rather than dropping them.
   */
  instructions?: string | null
  /**
   * The resolved model group this session was created under, machine-readable
   * so a later reader — a delegation request naming a slot, say — resolves the
   * same harness/model/effort the creator chose instead of re-parsing the
   * instruction prose the group was also rendered into.
   */
  group?: SessionModelGroup | null
  handoff?: SessionHandoff | null
}

/**
 * Partial update for a session config.
 *
 * - `undefined` leaves a field unchanged.
 * - `null` clears optional nullable fields.
 * - a value replaces the field.
 *
 * `harness` is a full replacement, not a deep merge.
 */
export type SessionConfigUpdate = {
  permissionCeiling?: SessionConfig["permissionCeiling"]
  permissionMode?: string | null
  permissionModeLabel?: string | null
  permissionState?: Record<string, unknown> | null
  harness?: SessionHarness
  model?: PromptModel | null
  variant?: string | null
  agent?: string | null
  instructions?: string | null
  group?: SessionModelGroup | null
  handoff?: SessionHandoff | null
}

/**
 * What an adapter observed while trying to stop a turn. Execution and cleanup
 * are separate facts because acknowledging a cancel is not stopping, and an
 * adapter that closed its own stream has not thereby released the provider's
 * terminals or child processes. `unknown` is the answer whenever the adapter's
 * protocol cannot tell those apart; the runtime keeps the turn owned on it.
 */
export type AdapterCancelOutcome = {
  execution: ExecutionFact
  cleanup: CleanupFact
  error?: { code: RecoveryErrorCode; message: string }
}

export type SteerResult =
  | { ok: true }
  | { ok: false; status: "no_active_turn" | "declined" | "unsupported" | "unknown"; message: string }
