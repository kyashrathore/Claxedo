import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime/contracts"
import { NO_HARNESS_EFFORT, type AdapterCancelOutcome, type HarnessConnectionCapabilities, type SessionConfig, type SteerResult } from "@claxedo/agent-runtime-contract"
import type {
  AgentListOperations,
  AttachInput,
  CommandOperations,
  ConfigApplied,
  ConfigOperations,
  Deadline,
  ForkOperations,
  HarnessServices,
  HistoryOperations,
  HarnessSession,
  HarnessTransport,
  HealthOperations,
  NamingOperations,
  NativeGoalOperations,
  RoutedEvent,
  SessionBroker,
  StartInput,
  SteerOperations,
  TransportCapabilities,
  TransportConfigUpdate,
  TransportKind,
  TurnBroker,
  TurnInput,
  TurnRef,
} from "@claxedo/harness/contract"
import type { CustomHarnessProvider, HarnessConnectionDescriptor } from "@claxedo/harness/providers"

export const FAKE_CONNECTION_CAPABILITIES: HarnessConnectionCapabilities = {
  abort: true, reconnect: false, replay: true, permissions: false, questions: false,
  todos: false, commands: false, fork: false, revert: false, unrevert: false,
  configOptions: false, subagents: false,
}

export const FAKE_TRANSPORT_CAPABILITIES: TransportCapabilities = {
  modelSelection: { status: "unsupported" },
  effortLevels: NO_HARNESS_EFFORT,
  instructionChannel: "turn-system-prompt",
  configOwner: "runtime",
  requests: { permissions: false, questions: false, elicitation: false },
  subagents: false,
  goals: { implemented: false, available: false, unavailableReason: "fake transport", actions: [], optionalFields: [], recovery: "blocked" },
  todos: false,
  history: "store",
  titles: "none",
  pluginIntake: { mcp: "none", skills: "none" },
  mcpTransports: { stdio: false, http: false, sse: false },
  timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-turn", credentials: "next-turn" },
}

export type FakeTurn = {
  session: HarnessSession
  turn: TurnInput
  broker: TurnBroker
}

export type FakeCancel = {
  session: HarnessSession
  turn: TurnRef
  deadline: Deadline
}

export type FakeTransportOptions = {
  kind?: TransportKind
  capabilities?: Partial<TransportCapabilities>
  /** What one turn yields; the default answers "ack" and finishes. */
  turn?: (input: FakeTurn) => AsyncIterable<AgentRuntimeEvent>
  /** The upstream id a started session is bound to; the default derives one from the session id. */
  upstreamSessionId?: (input: StartInput) => string
  onStart?: (input: StartInput, config: SessionConfig) => void
  onClose?: (session: HarnessSession) => void
  onDispose?: () => void | Promise<void>
  /** Awaited inside `start`, before the session binds; a test parks a create or asks a startup request here. */
  beforeStart?: (input: StartInput, session: SessionBroker) => Promise<void>
  /** Awaited inside every `capabilities` read; a test parks a caller between its admission read and its harness read here. */
  beforeCapabilities?: () => Promise<void>
  /** What a cancel answers; the default reports the turn terminal and its cleanup verified. */
  cancel?: (input: FakeCancel) => Promise<AdapterCancelOutcome>
  /** What a configuration push answers; the default applies it. */
  configure?: (update: TransportConfigUpdate, transport: FakeTransport) => ConfigApplied | Promise<ConfigApplied>
  steer?: (session: HarnessSession, turn: TurnRef, input: TurnInput) => Promise<SteerResult>
  fork?: ForkOperations["fork"]
  config?: ConfigOperations
  history?: HistoryOperations
  commands?: CommandOperations
  agents?: AgentListOperations
  goals?: NativeGoalOperations
  naming?: NamingOperations
  health?: HealthOperations
}

async function* ackTurn(input: FakeTurn): AsyncIterable<AgentRuntimeEvent> {
  yield { type: "text-delta", delta: "ack" }
  yield { type: "finish", sessionId: input.session.binding.sessionId }
}

/**
 * A transport whose whole behaviour is the script it was handed: every start
 * rebinds the store to the upstream id it minted through the session broker,
 * the way a real transport does, and every turn plays `options.turn`. Starts,
 * attaches, turns, cancels, configuration pushes and closes are recorded, and
 * nothing runs outside the process. The host under test is real; only the
 * harness behind it is scripted.
 */
export class FakeTransport implements HarnessTransport {
  readonly kind: TransportKind
  readonly starts: StartInput[] = []
  readonly attaches: AttachInput[] = []
  readonly turns: FakeTurn[] = []
  readonly cancels: FakeCancel[] = []
  readonly configures: TransportConfigUpdate[] = []
  readonly closed: HarnessSession[] = []
  disposed = false
  activeStarts = 0
  activeTurns = 0
  config: ConfigOperations | undefined
  history: HistoryOperations | undefined
  commands: CommandOperations | undefined
  agents: AgentListOperations | undefined
  goals: NativeGoalOperations | undefined
  naming: NamingOperations | undefined
  health: HealthOperations | undefined
  readonly steer: SteerOperations | undefined
  readonly fork: ForkOperations | undefined
  private readonly options: FakeTransportOptions

  constructor(options: FakeTransportOptions = {}) {
    this.options = options
    this.kind = options.kind ?? "acp"
    this.config = options.config
    this.history = options.history
    this.commands = options.commands
    this.agents = options.agents
    this.goals = options.goals
    this.naming = options.naming
    this.health = options.health
    this.steer = options.steer ? { steer: options.steer } : undefined
    this.fork = options.fork ? { fork: options.fork } : undefined
  }

  get cancelled(): TurnRef[] {
    return this.cancels.map((cancel) => cancel.turn)
  }

  async capabilities(): Promise<TransportCapabilities> {
    await this.options.beforeCapabilities?.()
    return { ...FAKE_TRANSPORT_CAPABILITIES, ...this.options.capabilities }
  }

  async start(input: StartInput, session: SessionBroker): Promise<HarnessSession> {
    this.activeStarts++
    try {
      await this.options.beforeStart?.(input, session)
      this.starts.push(input)
      this.options.onStart?.(input, input.config)
      const binding = await session.rebind(this.options.upstreamSessionId?.(input) ?? `upstream-${input.sessionId}`)
      return { binding, directory: input.directory, locality: input.locality }
    } finally {
      this.activeStarts--
    }
  }

  async attach(input: AttachInput, _session: SessionBroker): Promise<HarnessSession> {
    this.attaches.push(input)
    return { binding: input.binding, directory: input.directory, locality: input.locality }
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const input = { session, turn, broker }
    this.turns.push(input)
    this.activeTurns++
    try {
      for await (const event of (this.options.turn ?? ackTurn)(input)) {
        if (broker.signal.aborted) return
        yield { event }
      }
    } finally {
      this.activeTurns--
    }
  }

  /** Not `async`: a script that throws must throw into the caller, the way a transport that fails on the way in does. */
  cancel(session: HarnessSession, turn: TurnRef, deadline: Deadline): Promise<AdapterCancelOutcome> {
    const input = { session, turn, deadline }
    this.cancels.push(input)
    if (this.options.cancel) return this.options.cancel(input)
    return Promise.resolve({ execution: "terminal", cleanup: "verified_clear" })
  }

  async configure(_session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    this.configures.push(update)
    return this.options.configure ? await this.options.configure(update, this) : { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    this.closed.push(session)
    this.options.onClose?.(session)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.options.onDispose?.()
  }
}

export type FakeProviderInput<TConfig = Record<string, never>, TResolved = TConfig> = {
  providerKey: string
  label?: string | ((config: TConfig) => string)
  capabilities?: HarnessConnectionCapabilities
  validateConfig?: (input: unknown) => TConfig
  resolve?: (input: { descriptor: HarnessConnectionDescriptor<TConfig>; directory: string; secrets: Readonly<Record<string, string>> }) => TResolved
  transport: (input: {
    descriptor: HarnessConnectionDescriptor<TConfig>
    resolved: { connectionId: string; configRevision: number; config: TResolved }
    services: HarnessServices
  }) => HarnessTransport
}

/**
 * A connection provider that installs a fake transport under `providerKey`;
 * a descriptor naming that key on the runtime snapshot reaches `transport`,
 * which sees what the composer hands a real provider: the validated
 * descriptor, the resolved config and the host services.
 */
export function fakeConnectionProvider<TConfig = Record<string, never>, TResolved = TConfig>(
  input: FakeProviderInput<TConfig, TResolved>,
): CustomHarnessProvider<TConfig, TResolved> {
  const label = (config: TConfig) => typeof input.label === "function" ? input.label(config) : input.label ?? input.providerKey
  return {
    providerKey: input.providerKey,
    validateConfig: input.validateConfig ?? (() => ({}) as TConfig),
    immutableIdentity: () => input.providerKey,
    project: (config) => ({ label: label(config), readiness: "ready", capabilities: input.capabilities ?? FAKE_CONNECTION_CAPABILITIES }),
    resolve: ({ descriptor, directory, secrets }) => ({
      connectionId: descriptor.connectionId,
      configRevision: descriptor.configRevision,
      config: input.resolve ? input.resolve({ descriptor, directory, secrets }) : (descriptor.config as unknown as TResolved),
    }),
    createTransport: ({ descriptor, resolved, services }) => input.transport({ descriptor, resolved, services }),
  }
}
