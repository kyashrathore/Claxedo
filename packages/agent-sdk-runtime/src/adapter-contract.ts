import type { CompatEvent } from "./compat-events"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { StatusChunk } from "./status"
import { GoalCapabilityError } from "./capabilities"
import type { AdapterCapability, GoalCapabilities, HarnessCapabilityContext, HarnessCapabilities } from "./capabilities"
import type { AgentProcessObserver } from "./process-observer"
import type { AgentMessagePage, AgentMessagePageInput } from "./message-page"
import type {
  AgentAgent,
  AgentCommand,
  AgentConfigOption,
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentRuntimeStreamEvent,
  AgentSession,
  PromptInput,
  RuntimeDirectory,
  SessionConfig,
  SessionConfigUpdate,
} from "./index"

export type AbortResult =
  | { ok: true; status: "cancelled" | "already_idle" }
  | { ok: false; status: "not_found" | "recovering" | "failed"; message: string }

export type AgentHarnessAdapterHealth = {
  status: "ok" | "degraded" | "unavailable"
  reason?: string
  message?: string
  sessions?: Array<{
    id: string
    status?: string | null
    message?: string | null
  }>
}

export type AgentHarnessAdapterHealthContext = {
  /** Restrict health to the session being observed instead of workspace history. */
  sessionId?: string
}

export type PermissionDecision = "allow_once" | "allow_always" | "deny" | "reject_always"

export type AgentHarnessAdapterProcessOptions = {
  /** Optional local diagnostics sink. Observation never changes harness behavior. */
  processObserver?: AgentProcessObserver
}

/**
 * An injectable HTTP seam. Only the call signature is ever used, so this is
 * deliberately narrower than `typeof fetch` — the platform type also carries
 * `preconnect`, which no caller here touches and which would force every
 * injected double to fabricate it.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type AgentInteractionResult = {
  events: CompatEvent[]
}

export type AgentHandoffSessionOptions = {
  /** Canonical source transcript to install before the target's first turn. */
  system: string
}

export { AgentMessagePageError } from "./message-page"
export type { AgentMessagePage, AgentMessagePageInput } from "./message-page"

export interface AgentHarnessAdapterCore {
  readonly adapterCapabilities?: readonly AdapterCapability[]
  readonly commitsStreamEvents?: boolean

  listSessions(directory: RuntimeDirectory): Promise<AgentSession[]>
  getSession(id: string, directory: RuntimeDirectory): Promise<AgentSession | null>
  createSession(directory: RuntimeDirectory, title?: string, id?: string): Promise<{ id: string }>
  /** Create a fresh provider-native thread behind an existing Claxedo session. */
  createHandoffSession?(directory: RuntimeDirectory, title: string | undefined, id: string, options: AgentHandoffSessionOptions): Promise<{ id: string; agentSessionId?: string; ownerKey?: string | null }>
  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, directory: RuntimeDirectory): Promise<AgentSession | null>
  getSessionConfig(id: string, directory: RuntimeDirectory): Promise<SessionConfig>
  updateSessionConfig(id: string, update: SessionConfigUpdate, directory: RuntimeDirectory): Promise<SessionConfig>
  deleteSession(id: string, directory: RuntimeDirectory): Promise<void>

  readHarnessCapabilities(directory: RuntimeDirectory, context?: HarnessCapabilityContext): Promise<HarnessCapabilities> | HarnessCapabilities

  sendMessage(id: string, input: PromptInput, directory: RuntimeDirectory): AsyncIterable<AgentRuntimeStreamEvent>
  getMessages(id: string, directory: RuntimeDirectory): Promise<AgentMessage[]>

  listCommands?(directory: RuntimeDirectory): Promise<AgentCommand[]>
  readRuntimeHealth?(directory: RuntimeDirectory, context?: AgentHarnessAdapterHealthContext): AgentHarnessAdapterHealth

  dispose(): void
}

export interface SupportsAbort {
  abort(id: string, directory: RuntimeDirectory): Promise<AbortResult>
}

export interface SupportsRevert {
  revert(id: string, directory: RuntimeDirectory): Promise<void>
}

export interface SupportsUnrevert {
  unrevert(id: string, directory: RuntimeDirectory): Promise<void>
}

export interface SupportsFork {
  forkSession(id: string, messageId: string, directory: RuntimeDirectory): Promise<{ id: string }>
}

export interface SupportsCommands {
  executeCommand(id: string, command: string, directory: RuntimeDirectory): Promise<void>
}

/**
 * Authoritative transcript windows for interactive readers.
 *
 * `getMessages` remains the complete-history contract used by checkpoints and
 * snapshots. Numeric pages are bounded; semantic views define their own
 * authoritative boundary. Cursors are opaque and owned by the producer, and
 * consumers must forward them unchanged rather than deriving replacements.
 */
export interface SupportsMessagePages {
  getMessagePage(id: string, input: AgentMessagePageInput, directory: RuntimeDirectory): Promise<AgentMessagePage>
}

export interface SupportsAgents {
  listAgents(directory: RuntimeDirectory): Promise<AgentAgent[]>
}

export interface SupportsTodos {
  getTodos(sessionId: string, directory: RuntimeDirectory): Promise<Array<{ content: string; status: string; priority: string }>>
}

export type AgentGoalStartInput = {
  objective: string
}

export type AgentGoalMutationFailure = {
  ok: false
  status: "unsupported" | "unavailable" | "not_found" | "conflict" | "failed"
  message: string
}

export type AgentGoalMutationResult<Goal extends RuntimeGoalSnapshot | null = RuntimeGoalSnapshot | null> =
  | { ok: true; goal: Goal }
  | AgentGoalMutationFailure

/**
 * One session-scoped Goal resource. Action methods remain present so adapters
 * have one complete contract; callers must gate them with readCapabilities.
 */
export interface AgentGoalResource {
  readCapabilities(sessionId: string, directory: RuntimeDirectory): Promise<GoalCapabilities> | GoalCapabilities
  read(sessionId: string, directory: RuntimeDirectory): Promise<RuntimeGoalSnapshot | null>
  start(sessionId: string, input: AgentGoalStartInput, directory: RuntimeDirectory): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>>
  pause(sessionId: string, directory: RuntimeDirectory): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>>
  resume(sessionId: string, directory: RuntimeDirectory): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>>
  /** Disable future continuation before interrupting active work. */
  stop(sessionId: string, directory: RuntimeDirectory): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot | null>>
  delete(sessionId: string, directory: RuntimeDirectory): Promise<AgentGoalMutationResult<null>>
}

export interface SupportsGoals {
  readonly goals: AgentGoalResource
}

function isGoalResource(value: unknown): value is AgentGoalResource {
  if (!value || typeof value !== "object") return false
  const resource = value as Partial<Record<keyof AgentGoalResource, unknown>>
  return ["readCapabilities", "read", "start", "pause", "resume", "stop", "delete"]
    .every((method) => typeof resource[method as keyof AgentGoalResource] === "function")
}

export function requireGoalResource(adapter: AgentHarnessAdapter): AgentGoalResource {
  if (!isGoalResource(adapter.goals)) {
    throw new GoalCapabilityError("This harness does not expose the Goal resource")
  }
  return adapter.goals
}

export interface SupportsPermissions {
  listPermissions(directory: RuntimeDirectory): Promise<AgentPermission[]>
  respondPermission(permId: string, decision: PermissionDecision, directory: RuntimeDirectory): Promise<AgentInteractionResult | void>
}

/**
 * The three rungs every harness's permission surface is mapped onto.
 *
 * A LADDER, not a taxonomy: the rungs are ordered by how much runs without
 * asking, and that ordering is the only thing shared across harnesses. What each
 * rung concretely does is the harness's business and differs wildly — `auto` is
 * an OS sandbox on codex, a model classifier on claude and cursor, and a rule
 * list on opencode.
 *
 * `level` is therefore a HINT for choosing a default, never a promise about
 * behaviour. Anything user-facing must show `AgentPermissionMode.name` — the
 * harness's own word for it — because that is the only label guaranteed to
 * describe what actually happens.
 */
export type AutoLevel = "ask" | "auto" | "full"

/** One selectable permission mode, in the harness's own vocabulary. */
export type AgentPermissionMode = {
  id: string
  /** The harness's own name. Rendered as-is; never paraphrased. */
  name: string
  description?: string
  /**
   * Which rung this is, when it maps to one at all. Absent means the harness
   * offers it but it does not correspond to a rung — still selectable, just not
   * a candidate for the default.
   */
  level?: AutoLevel
}

export type AgentPermissionModeState = {
  modes: AgentPermissionMode[]
  /**
   * Read back from the harness, never assumed from the last write. An ACP agent
   * may clamp this to a different mode when its available set changes.
   */
  currentModeId?: string
  /**
   * Set when this harness has no mode surface. Distinct from `modes: []`, which
   * means it has one and reported nothing — greying out for the right reason
   * requires telling those apart.
   */
  unsupported?: string
  /**
   * When a change lands. `next-session` is not a rounding error: on cursor these
   * are `Agent.create` options, so a change cannot affect the session in front
   * of the user at all.
   */
  appliesFrom: "next-turn" | "next-session"
}

export interface SupportsPermissionModes {
  listPermissionModes(sessionId: string, directory: RuntimeDirectory): Promise<AgentPermissionModeState>
  /**
   * Returns the state read back AFTER the write, which is why it does not return
   * void: the caller must be able to see that the harness kept something other
   * than what was asked for.
   */
  setPermissionMode(sessionId: string, modeId: string, directory: RuntimeDirectory): Promise<AgentPermissionModeState>
}

export interface SupportsQuestions {
  listQuestions(directory: RuntimeDirectory): Promise<AgentQuestion[]>
  replyQuestion(qId: string, answer: string, directory: RuntimeDirectory): Promise<AgentInteractionResult | void>
  rejectQuestion(qId: string, directory: RuntimeDirectory): Promise<AgentInteractionResult | void>
}

export interface SupportsRuntimeConfig {
  applyConfig(config: Record<string, unknown>): Promise<void>
  waitForConfigReady?(): Promise<void>
}

export interface SupportsConfigOptions {
  probeConfigOptions(directory: RuntimeDirectory): Promise<AgentConfigOption[]>
  peekConfigOptions?(directory: RuntimeDirectory): Promise<AgentConfigOption[] | null> | AgentConfigOption[] | null
}

export type AgentHarnessAdapter =
  & AgentHarnessAdapterCore
  & Partial<SupportsAbort>
  & Partial<SupportsRevert>
  & Partial<SupportsUnrevert>
  & Partial<SupportsFork>
  & Partial<SupportsCommands>
  & Partial<SupportsMessagePages>
  & Partial<SupportsPermissionModes>
  & Partial<SupportsAgents>
  & Partial<SupportsTodos>
  & Partial<SupportsPermissions>
  & Partial<SupportsQuestions>
  & Partial<SupportsRuntimeConfig>
  & Partial<SupportsConfigOptions>
  & Partial<SupportsGoals>

export type AgentRuntimeStatusChunk = StatusChunk
