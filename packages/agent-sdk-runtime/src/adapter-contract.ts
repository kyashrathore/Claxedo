import { isRecord } from "@claxedo/agent-runtime-contract"
import type { CompatEvent } from "./compat-events"
import type {
  AgentExecutionBinding,
  AgentQuestionAnswer,
  HarnessInstructionChannel,
  SessionModelGroup,
} from "@claxedo/agent-runtime-contract"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { GoalCapabilityError } from "./capabilities"
import type { AdapterCapability, GoalCapabilities, HarnessCapabilityContext, HarnessCapabilities } from "./capabilities"
import type { AgentProcessObserver } from "./process-observer"
import type { AgentMessagePage, AgentMessagePageInput } from "./message-page"
import type { SessionTitleRequest } from "./title-generation"
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

export type SteerResult =
  | { ok: true }
  | { ok: false; status: "no_active_turn" | "declined" | "failed"; message: string }

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

export type AgentTurnWriteContext = {
  /** Durable authority generation required by every authoritative turn write. */
  fencingToken?: number
}

/**
 * The fencing fields an adapter spreads onto every store write it makes for a
 * turn. A turn started without a write context produces no fields at all, so an
 * unfenced store never sees a token it cannot check.
 */
export function turnWriteFence(writeContext: AgentTurnWriteContext | undefined): { fencingToken?: number } {
  if (writeContext?.fencingToken === undefined) return {}
  return { fencingToken: writeContext.fencingToken }
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

export type AgentSessionCreateOptions = {
  /**
   * Standing instructions for the new session. An adapter whose
   * `instructionChannel` is `none` is never given them: dropping the block
   * would leave the session running under something its creator never chose.
   */
  instructions?: string
  /**
   * The resolved model group the session runs under. Runtime metadata, not a
   * harness input: it is retained so a later delegation resolves the same
   * harness/model/effort the creator chose.
   */
  group?: SessionModelGroup
}

export type AgentPreparedHandoffSession = {
  id: string
  agentSessionId?: string
  ownerKey?: string | null
  /** Idempotently release only the newly-created target-native resources. */
  rollback(): Promise<void>
}

export { AgentMessagePageError } from "./message-page"
export type { AgentMessagePage, AgentMessagePageInput } from "./message-page"

export interface AgentHarnessAdapterCore {
  readonly adapterCapabilities?: readonly AdapterCapability[]
  /**
   * How this adapter takes a session's standing instruction block. It decides
   * both admission — `none` refuses a create that carries one — and where the
   * block is delivered, so nothing composes it into a turn a harness already
   * holds it for.
   */
  readonly instructionChannel: HarnessInstructionChannel
  readonly commitsStreamEvents?: boolean
  /**
   * Where durable SessionConfig is authoritative. Most SDK harnesses own and
   * read back their config. Protocol adapters whose choices are carried on
   * each turn can delegate that state to the Claxedo runtime store.
   */
  readonly sessionConfigOwner?: "adapter" | "runtime"

  getSession(binding: AgentExecutionBinding): Promise<AgentSession | null>
  createSession(directory: RuntimeDirectory, title?: string, id?: string, options?: AgentSessionCreateOptions): Promise<{ id: string; agentSessionId?: string }>
  /** Create a fresh provider-native thread behind an existing Claxedo session. */
  createHandoffSession?(directory: RuntimeDirectory, title: string | undefined, id: string, options: AgentHandoffSessionOptions): Promise<AgentPreparedHandoffSession>
  /** Release the no-longer-authoritative source resources after a handoff commits. */
  releaseHandoffSource?(id: string, agentSessionId: string, ownerKey: string | null, directory: RuntimeDirectory): Promise<void>
  /** Apply provider/process effects and return the accepted session without writing the RuntimeStore. */
  updateSession(binding: AgentExecutionBinding, updates: { title?: string; time?: { archived?: number } }): Promise<AgentSession | null>
  /**
   * Ask the harness for a session title through a side turn that leaves the
   * session's own transcript untouched. Returns the model's raw reply; the
   * runtime cleans and ranks it. Absent on harnesses that title sessions
   * themselves (their title arrives on the event stream instead).
   */
  generateTitle?(binding: AgentExecutionBinding, request: SessionTitleRequest): Promise<string | null>
  getSessionConfig(binding: AgentExecutionBinding): Promise<SessionConfig>
  /** Apply the runtime-supplied complete config and return the accepted config without writing the RuntimeStore. */
  updateSessionConfig(binding: AgentExecutionBinding, update: SessionConfigUpdate): Promise<SessionConfig>
  /** Release provider/process resources without deleting the RuntimeStore session. */
  deleteSession(binding: AgentExecutionBinding): Promise<void>

  readHarnessCapabilities(directory: RuntimeDirectory, context?: HarnessCapabilityContext): Promise<HarnessCapabilities> | HarnessCapabilities

  executeTurn(
    binding: AgentExecutionBinding,
    input: PromptInput,
    writeContext?: AgentTurnWriteContext,
  ): AsyncIterable<AgentRuntimeStreamEvent>
  getMessages(binding: AgentExecutionBinding): Promise<AgentMessage[]>

  listCommands?(directory: RuntimeDirectory): Promise<AgentCommand[]>
  readRuntimeHealth?(directory: RuntimeDirectory, context?: AgentHarnessAdapterHealthContext): AgentHarnessAdapterHealth

  dispose(): void | Promise<void>
}

export interface SupportsAbort {
  abort(binding: AgentExecutionBinding): Promise<AbortResult>
}

/**
 * Hands a prompt to the turn already running for this session instead of
 * starting one. Only a harness whose protocol accepts input mid-turn implements
 * it; the runtime queues for the rest.
 */
export interface SupportsSteer {
  steerTurn(binding: AgentExecutionBinding, input: PromptInput): Promise<SteerResult>
}

export interface SupportsRevert {
  revert(binding: AgentExecutionBinding): Promise<void>
}

export interface SupportsUnrevert {
  unrevert(binding: AgentExecutionBinding): Promise<void>
}

export interface SupportsFork {
  forkSession(binding: AgentExecutionBinding, messageId: string, childSessionId?: string): Promise<{ id: string }>
}

export interface SupportsCommands {
  executeCommand(binding: AgentExecutionBinding, command: string): Promise<void>
}

export type ShellCommandInput = {
  command: string
  agent: string
  model?: { providerID: string; modelID: string }
  messageID?: string
}

export interface SupportsShell {
  /** Run a shell command in the session context, same command-channel category as `executeCommand`. */
  shell(id: string, input: ShellCommandInput, directory: RuntimeDirectory): Promise<void>
}

export type SummarizeSessionInput = {
  providerID: string
  modelID: string
  auto?: boolean
}

export interface SupportsSummarize {
  /** Compact the session transcript into an AI-generated summary (the `/compact` command). */
  summarize(id: string, input: SummarizeSessionInput, directory: RuntimeDirectory): Promise<void>
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
  getMessagePage(binding: AgentExecutionBinding, input: AgentMessagePageInput): Promise<AgentMessagePage>
}

export interface SupportsAgents {
  listAgents(directory: RuntimeDirectory): Promise<AgentAgent[]>
}

export interface SupportsTodos {
  getTodos(binding: AgentExecutionBinding): Promise<Array<{ content: string; status: string; priority: string }>>
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
  stop(sessionId: string, directory: RuntimeDirectory): Promise<AgentGoalMutationResult>
  delete(sessionId: string, directory: RuntimeDirectory): Promise<AgentGoalMutationResult<null>>
}

export interface SupportsGoals {
  readonly goals: AgentGoalResource
}

const GOAL_RESOURCE_METHODS = ["readCapabilities", "read", "start", "pause", "resume", "stop", "delete"] as const

function isGoalResource(value: unknown): value is AgentGoalResource {
  if (!isRecord(value)) return false
  return GOAL_RESOURCE_METHODS.every((method) => typeof value[method] === "function")
}

export function requireGoalResource(adapter: AgentHarnessAdapter): AgentGoalResource {
  if (!isGoalResource(adapter.goals)) {
    throw new GoalCapabilityError("This harness does not expose the Goal resource")
  }
  return adapter.goals
}

export interface SupportsPermissions {
  listPermissions(directory: RuntimeDirectory): Promise<AgentPermission[]>
  respondPermission(binding: AgentExecutionBinding, permId: string, decision: PermissionDecision): Promise<AgentInteractionResult | void>
}

/**
 * The three rungs every harness's permission surface is mapped onto.
 *
 * A LADDER, not a taxonomy: the rungs are ordered by how much runs without
 * asking, and that ordering is the only thing shared across harnesses. What each
 * rung concretely does is the harness's business and differs wildly — `auto` is
 * an OS sandbox on codex and a model classifier on claude and cursor.
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
  listDraftPermissionModes?(directory: RuntimeDirectory): Promise<AgentPermissionModeState>
  listPermissionModes(binding: AgentExecutionBinding): Promise<AgentPermissionModeState>
  /**
   * Returns the state read back AFTER the write, which is why it does not return
   * void: the caller must be able to see that the harness kept something other
   * than what was asked for.
   */
  setPermissionMode(binding: AgentExecutionBinding, modeId: string): Promise<AgentPermissionModeState>
}

export interface SupportsQuestions {
  listQuestions(directory: RuntimeDirectory): Promise<AgentQuestion[]>
  replyQuestion(binding: AgentExecutionBinding, qId: string, answers: AgentQuestionAnswer[]): Promise<AgentInteractionResult | void>
  rejectQuestion(binding: AgentExecutionBinding, qId: string): Promise<AgentInteractionResult | void>
}

export interface SupportsRuntimeConfig {
  applyConfig(config: Record<string, unknown>): Promise<void>
  waitForConfigReady?(): Promise<void>
}

/**
 * The model a harness resolved for itself, in the harness's own vocabulary.
 *
 * `id` is the harness's model id and `name` is the label the harness published
 * for that id. Both come from the harness; neither is derived from a Claxedo
 * catalog, so this is what the agent will actually run, not what a client
 * asked for.
 */
export type ResolvedHarnessModel = {
  id: string
  name: string
}

/**
 * A harness's live configuration surface.
 *
 * `options` are the settings a client may change. `resolvedModel` is the model
 * the harness reports as current for the next turn — the answer for harnesses
 * that own model selection and therefore publish no model option to pick from.
 *
 * It is ABSENT whenever the harness named no current model, or named one it
 * published no label for. A client that receives no resolved model learns that
 * the harness did not report one; it never receives a guess or a default.
 */
export type AgentConfigOptions = {
  options: AgentConfigOption[]
  resolvedModel?: ResolvedHarnessModel
}

/**
 * The resolved model carried by a `model` select, when it carries one.
 *
 * Only the option's own `currentValue` and the label it published for that
 * value are read, so an option whose current value is absent from its own
 * choices resolves to nothing rather than to an unlabelled id.
 */
export function resolvedModelFromConfigOptions(
  options: readonly AgentConfigOption[],
): ResolvedHarnessModel | undefined {
  const option = options.find((item) => item.type === "select" && (item.category === "model" || item.id === "model"))
  const id = typeof option?.currentValue === "string" ? option.currentValue : undefined
  if (!id) return undefined
  const name = option?.selectOptions?.find((item) => item.id === id)?.name
  return name ? { id, name } : undefined
}

export interface SupportsConfigOptions {
  probeConfigOptions(directory: RuntimeDirectory): Promise<AgentConfigOptions>
  peekConfigOptions?(directory: RuntimeDirectory): Promise<AgentConfigOptions | null> | AgentConfigOptions | null
}

export type AgentHarnessAdapter =
  & AgentHarnessAdapterCore
  & Partial<SupportsAbort>
  & Partial<SupportsSteer>
  & Partial<SupportsRevert>
  & Partial<SupportsUnrevert>
  & Partial<SupportsFork>
  & Partial<SupportsCommands>
  & Partial<SupportsShell>
  & Partial<SupportsSummarize>
  & Partial<SupportsMessagePages>
  & Partial<SupportsPermissionModes>
  & Partial<SupportsAgents>
  & Partial<SupportsTodos>
  & Partial<SupportsPermissions>
  & Partial<SupportsQuestions>
  & Partial<SupportsRuntimeConfig>
  & Partial<SupportsConfigOptions>
  & Partial<SupportsGoals>
