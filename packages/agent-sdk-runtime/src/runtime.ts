import { randomUUID } from "crypto"
import type {
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentRuntimeStreamEvent,
  AgentSession,
  HarnessCapabilities,
  PromptInput,
  PromptModel,
  RuntimeDirectory,
  SessionConfig,
  SessionConfigUpdate,
  SessionHarness,
} from "./index"
import type { AgentHarnessAdapter } from "./adapter-contract"
import { hasAdapterCapability } from "./capabilities"
import { eventSessionId, type CompatEvent } from "./compat-events"
import { createRuntimeEventHub, type RuntimeEventHub } from "./runtime-event-hub"
import type { AgentRuntimeStoreWithRecovery } from "./harnesses/shared/runtime-store"
import { resolveSessionModel } from "./session-model"
import { executeHandoffTransaction } from "./runtime/handoff-transaction"
import { createTitleMutationCoordinator } from "./runtime/title-mutations"
import { runRuntimeTurn } from "./runtime/turn-runner"

declare const agentRuntimeStore: unique symbol
declare const agentHarnessFactory: unique symbol

export type AgentRuntimeStore = {
  readonly [agentRuntimeStore]: true
}

type RuntimeStoreInternal = AgentRuntimeStoreWithRecovery
type InternalAgentHarnessFactory = {
  id: SessionHarness["id"]
  access: SessionHarness["access"]
  create(context: AgentHarnessFactoryContext): AgentHarnessAdapter
}

export type AgentRuntimeAbortResult =
  | { ok: true; status: "cancelled" | "already_idle" }
  | { ok: false; status: "not_found" | "recovering" | "failed"; message: string }

export type AgentRuntimePermissionDecision = "allow_once" | "allow_always" | "deny" | "reject_always"

export type AgentRuntimeInteractionResult = {
  events: CompatEvent[]
}

export type AgentRuntimeHealth = {
  status: "ok" | "degraded" | "unavailable"
  reason?: string
  message?: string
  sessions?: Array<{
    id: string
    status?: string | null
    message?: string | null
  }>
}

type AgentHarnessFactoryContext = {
  store: RuntimeStoreInternal
  eventHub: RuntimeEventHub
}

export type AgentHarnessFactory = {
  id: SessionHarness["id"]
  access: SessionHarness["access"]
  readonly [agentHarnessFactory]: true
}

export type CreateAgentRuntimeInput = {
  store: AgentRuntimeStore
  harnesses: AgentHarnessFactory[]
  resolveHarness?: (harness: SessionHarness) => AgentHarnessAdapter | Promise<AgentHarnessAdapter>
  eventDelivery?: AgentRuntimeEventDeliveryPolicy
}

export type AgentRuntimeEventEnvelope = {
  sessionId: string
  directory: RuntimeDirectory
  payload: AgentRuntimeStreamEvent
}

export type AgentRuntimeSubscribeInput = {
  sessionId?: string
  directory?: RuntimeDirectory
  identity?: AgentRuntimeSubscriptionIdentity
}

export type AgentRuntimeSubscriptionIdentity = {
  connectionId: string
  actorId: string
  actorKind: "human" | "agent"
  orgId: string
  workspaceId: string
  role: "viewer" | "editor" | "admin" | "owner"
  /** Opaque signed proof forwarded only to the host's authorization policy. */
  credential?: string
}

export type AgentRuntimeEventDeliveryPolicy = (input: {
  identity: AgentRuntimeSubscriptionIdentity
  event: AgentRuntimeEventEnvelope
}) => "deliver" | "omit" | "terminate" | Promise<"deliver" | "omit" | "terminate">

export type AgentRuntimeSessionCreateInput = {
  id?: string
  directory: RuntimeDirectory
  harness: SessionHarness
  model?: PromptModel
  variant?: string | null
  agent?: string | null
  title?: string
}

type AgentRuntimeTurnActor =
  | { actorId: string; actorKind: "human" | "agent" }
  | { actorId?: never; actorKind?: never }

export type AgentRuntimeTurnStartInput = {
  sessionId: string
  /** Runs after this turn wins the per-session lease and before harness work starts. */
  onAdmitted?: () => void
  text?: string
  parts?: unknown[]
  messageId?: string
  assistantMessageId?: string
  agent?: string
  model?: PromptModel
  tools?: Record<string, boolean>
  format?: PromptInput["format"]
  system?: string
  permissionMode?: string
  variant?: string
  author?: PromptInput["author"]
} & AgentRuntimeTurnActor

export type AgentRuntimeTurnStartResult = {
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  directory: RuntimeDirectory
  prompt: PromptInput
}

export const AGENT_RUNTIME_TURN_CONFLICT_CODE = "session_turn_in_progress"

export class AgentRuntimeTurnConflictError extends Error {
  readonly code = AGENT_RUNTIME_TURN_CONFLICT_CODE
  readonly status = 409

  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is already processing a turn`)
    this.name = "AgentRuntimeTurnConflictError"
  }
}

export function isAgentRuntimeTurnConflictError(error: unknown): error is AgentRuntimeTurnConflictError {
  return error instanceof AgentRuntimeTurnConflictError
    || !!error && typeof error === "object"
      && (error as { code?: unknown }).code === AGENT_RUNTIME_TURN_CONFLICT_CODE
}

type Subscriber = {
  input: AgentRuntimeSubscribeInput
  push(event: AgentRuntimeEventEnvelope): void
  close(): void
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>

const CENTRAL_DIRECTORY = ""

function runtimeDirectory(directory: RuntimeDirectory) {
  return directory ?? CENTRAL_DIRECTORY
}

function turnPrompt(
  turn: AgentRuntimeTurnStartInput,
  config: SessionConfig,
  userMessageId: string,
  assistantMessageId: string,
  handoff: string | undefined,
): PromptInput {
  return {
    parts: turn.parts ?? (turn.text ? [{ type: "text", text: turn.text }] : []),
    userMessageId,
    assistantMessageId,
    agent: turn.agent ?? config?.agent ?? "build",
    model: turn.model ?? resolveSessionModel(config),
    ...(turn.tools ? { tools: turn.tools } : {}),
    ...(turn.format ? { format: turn.format } : {}),
    ...(handoff || turn.system ? { system: [handoff, turn.system].filter(Boolean).join("\n\n") } : {}),
    ...(turn.permissionMode ? { permissionMode: turn.permissionMode } : {}),
    ...(turn.variant !== undefined ? { variant: turn.variant } : config?.variant ? { variant: config.variant } : {}),
    ...(turn.author ? { author: turn.author } : {}),
  }
}

function turnStartRecord(
  turn: AgentRuntimeTurnStartInput,
  prompt: PromptInput,
  userMessageId: string,
  assistantMessageId: string,
  agentSessionId: string | undefined,
) {
  return {
    sessionId: turn.sessionId,
    ...(agentSessionId ? { agentSessionId } : {}),
    userMessageId,
    assistantMessageId,
    agent: prompt.agent,
    model: prompt.model,
    parts: prompt.parts,
    ...(turn.tools ? { tools: turn.tools } : {}),
    ...(turn.format ? { format: turn.format } : {}),
    ...(turn.system ? { system: turn.system } : {}),
    ...(prompt.variant ? { variant: prompt.variant } : {}),
    ...(turn.actorId && turn.actorKind ? { actorId: turn.actorId, actorKind: turn.actorKind } : {}),
    ...(turn.author ? { author: turn.author } : {}),
  }
}

function includesOpeningUserMessage(events: CompatEvent[], userMessageId: string) {
  return events.some((payload) =>
    payload.type === "message.updated"
    && payload.properties.info.role === "user"
    && payload.properties.info.id === userMessageId
  )
}

export function createAgentRuntime(input: CreateAgentRuntimeInput) {
  const eventHub = createRuntimeEventHub()
  const store = input.store as unknown as RuntimeStoreInternal
  const factories = input.harnesses as unknown as InternalAgentHarnessFactory[]
  const adapters = new Map(factories.map((factory) => [
    key(factory),
    factory.create({ store, eventHub }),
  ]))
  const resolvingAdapters = new Map<string, Promise<AgentHarnessAdapter>>()
  const subscribers = new Set<Subscriber>()
  const withTitleMutation = createTitleMutationCoordinator()
  const acquireTurnLease = (sessionId: string) => {
    const leaseId = store.acquireTurnLease(sessionId)
    if (!leaseId) throw new AgentRuntimeTurnConflictError(sessionId)
    return leaseId
  }

  const releaseTurnLease = (sessionId: string, leaseId: string) => {
    store.releaseTurnLease(sessionId, leaseId)
  }

  const adapterFor = async (harness: SessionHarness) => {
    const harnessKey = key(harness)
    const existing = adapters.get(harnessKey)
    if (existing) return existing
    if (!input.resolveHarness) throw new Error(`No harness registered for ${harness.id}:${harness.access}`)
    const pending = resolvingAdapters.get(harnessKey)
    if (pending) return await pending
    const resolution = Promise.resolve(input.resolveHarness(harness))
      .then((resolved) => {
        adapters.set(harnessKey, resolved)
        return resolved
      })
      .finally(() => resolvingAdapters.delete(harnessKey))
    resolvingAdapters.set(harnessKey, resolution)
    return await resolution
  }

  const adapterForSession = async (sessionId: string, directory: RuntimeDirectory) => {
    const config = store.getSessionConfig(sessionId)
    if (!config) throw new Error(`Session ${sessionId} has no runtime config`)
    return await adapterFor(config.harness)
  }

  const publish = (event: AgentRuntimeEventEnvelope) => {
    for (const subscriber of subscribers) {
      if (subscriber.input.sessionId && subscriber.input.sessionId !== event.sessionId) continue
      if (subscriber.input.directory !== undefined && subscriber.input.directory !== event.directory) continue
      subscriber.push(event)
    }
  }

  const publishInteractionEvents = (events: CompatEvent[] | undefined, directory: RuntimeDirectory) => {
    for (const payload of events ?? []) {
      const nextSessionId = eventSessionId(payload)
      if (nextSessionId) publish({ sessionId: nextSessionId, directory, payload })
    }
  }

  const commitAndPublish = (
    sessionId: string,
    directory: RuntimeDirectory,
    payload: CompatEvent,
    source: { dir: "in" | "out"; method: string },
  ): CompatEvent => {
    const agentSessionId = store.getAgentSessionId(sessionId) ?? undefined
    const committed = store.appendEvent({
      sessionId,
      ...(agentSessionId ? { agentSessionId } : {}),
      payload,
      source,
    }).payload
    publish({ sessionId, directory, payload: committed })
    return committed
  }

  const runTurn = async (
    sessionId: string,
    prompt: PromptInput,
    directory: RuntimeDirectory,
    adapter: AgentHarnessAdapter,
    openingUserAlreadyPublished = false,
    clearsHandoff = false,
  ) => await runRuntimeTurn({
    sessionId,
    prompt,
    directory,
    adapter,
    store,
    openingUserAlreadyPublished,
    clearsHandoff,
    publish,
    commit: (payload, source) => commitAndPublish(sessionId, directory, payload, source),
    withTitleMutation,
  })

  return {
    sessions: {
      async create(create: AgentRuntimeSessionCreateInput): Promise<AgentSession> {
        const adapter = await adapterFor(create.harness)
        if (create.model && hasAdapterCapability(adapter, "runtime-config")) {
          adapter.setModel(create.model.modelID === "default" ? "" : create.model.modelID)
        }
        const session = await adapter.createSession(create.directory, create.title, create.id)
        if (!store.getSession(session.id)) {
          store.bindSession({
            sessionId: session.id,
            directory: runtimeDirectory(create.directory),
            title: create.title,
            agentSessionId: session.id,
          })
        }
        const config: SessionConfig = {
          harness: create.harness,
          ...(create.model ? { model: create.model } : {}),
          variant: create.variant ?? null,
          agent: create.agent ?? null,
        }
        store.updateSessionConfig(session.id, config)
        return (await adapter.getSession(session.id, create.directory) ?? store.getSession(session.id)) as AgentSession
      },
      async get(sessionId: string, directory?: RuntimeDirectory): Promise<AgentSession | null> {
        const config = store.getSessionConfig(sessionId)
        if (!config) return store.getSession(sessionId) as AgentSession | null
        const projected = store.getSession(sessionId) as AgentSession | null
        const adapter = await adapterFor(config.harness)
        const live = await adapter.getSession(sessionId, directory) as AgentSession | null
        if (!live) return projected
        if (!projected) return live
        return {
          ...projected,
          ...live,
          status: projected.status,
          lastTurn: projected.lastTurn,
        }
      },
      async list(inputDirectory: RuntimeDirectory): Promise<AgentSession[]> {
        return store.listSessions(runtimeDirectory(inputDirectory)) as AgentSession[]
      },
      async update(sessionId: string, updates: { title?: string; time?: { archived?: number } }, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId, directory)
        if (updates.title === undefined) return await adapter.updateSession(sessionId, updates, directory) as AgentSession | null
        return await withTitleMutation(
          sessionId,
          async () => await adapter.updateSession(sessionId, updates, directory) as AgentSession | null,
        )
      },
      async updateConfig(sessionId: string, update: SessionConfigUpdate, directory?: RuntimeDirectory) {
        const current = store.getSessionConfig(sessionId)
        const changingHarness = !!current && !!update.harness && key(current.harness) !== key(update.harness)
        if (!changingHarness) {
          const adapter = await adapterForSession(sessionId, directory)
          return await adapter.updateSessionConfig(sessionId, update, directory)
        }
        const session = store.getSession(sessionId) as { title?: string | null; status?: string | null; directory?: string } | null
        if (!session) throw new Error(`Session ${sessionId} not found`)
        if (session.status === "busy") throw new Error("Wait for the current turn to finish before switching harness")
        const targetDirectory = directory ?? session.directory
        const source = await adapterFor(current!.harness)
        const target = await adapterFor(update.harness!)
        return await executeHandoffTransaction({
          sessionId,
          directory: targetDirectory,
          session,
          current: current!,
          update: { ...update, harness: update.harness! },
          store,
          source,
          target,
          commit: (payload) => commitAndPublish(sessionId, targetDirectory, payload, { dir: "out", method: "session/handoff" }),
          diagnose: (payload) => publish({ sessionId, directory: targetDirectory, payload }),
        })
      },
      async delete(sessionId: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId, directory)
        await adapter.deleteSession(sessionId, directory)
      },
    },
    turns: {
      async start(turn: AgentRuntimeTurnStartInput): Promise<AgentRuntimeTurnStartResult> {
        if ((turn.actorId === undefined) !== (turn.actorKind === undefined)) {
          throw new Error("Turn actor id and kind must be provided together")
        }
        const session = store.getSession(turn.sessionId) as { directory?: string } | null
        if (!session) throw new Error(`Session ${turn.sessionId} not found`)
        const leaseId = acquireTurnLease(turn.sessionId)
        try {
          turn.onAdmitted?.()
          const directory = session.directory ?? undefined
          const adapter = await adapterForSession(turn.sessionId, directory)
          const config = store.getSessionConfig(turn.sessionId) ?? await adapter.getSessionConfig(turn.sessionId, directory)
          const userMessageId = turn.messageId ?? `msg_${randomUUID()}`
          const assistantMessageId = turn.assistantMessageId ?? `${userMessageId}_r`
          const handoff = config?.handoff?.pending ? config.handoff.transcript : undefined
          const prompt = turnPrompt(turn, config, userMessageId, assistantMessageId, handoff)
          const agentSessionId = store.getAgentSessionId(turn.sessionId) ?? undefined
          const started = store.startTurn(turnStartRecord(turn, prompt, userMessageId, assistantMessageId, agentSessionId))
          for (const payload of started.events) {
            publish({ sessionId: turn.sessionId, directory, payload })
          }
          const openingUserPublished = includesOpeningUserMessage(started.events, userMessageId)
          void runTurn(turn.sessionId, prompt, directory, adapter, openingUserPublished, !!handoff)
            .finally(() => releaseTurnLease(turn.sessionId, leaseId))
          return { sessionId: turn.sessionId, userMessageId, assistantMessageId, directory, prompt }
        } catch (error) {
          releaseTurnLease(turn.sessionId, leaseId)
          throw error
        }
      },
      async abort(sessionId: string, directory?: RuntimeDirectory): Promise<AgentRuntimeAbortResult> {
        const adapter = await adapterForSession(sessionId, directory)
        if (!adapter.abort) throw new Error("This harness does not support abort")
        const result = await adapter.abort(sessionId, directory)
        if (result.ok && result.status === "cancelled") {
          store.finishTurn({
            sessionId,
            outcome: { status: "cancelled", completedAt: Date.now(), reason: "abort" },
          })
        }
        return result
      },
    },
    events: {
      subscribe(subscribe: AgentRuntimeSubscribeInput = {}) {
        return subscription(subscribers, subscribe, input.eventDelivery)
      },
      async list(sessionId: string, directory?: RuntimeDirectory): Promise<AgentMessage[]> {
        const adapter = await adapterForSession(sessionId, directory)
        return await adapter.getMessages(sessionId, directory) as AgentMessage[]
      },
    },
    permissions: {
      async list(directory: RuntimeDirectory): Promise<AgentPermission[]> {
        return merge(adapters, (adapter) => adapter.listPermissions?.(directory)) as Promise<AgentPermission[]>
      },
      async respond(permissionId: string, decision: AgentRuntimePermissionDecision, directory: RuntimeDirectory): Promise<AgentRuntimeInteractionResult | void> {
        const permission = (await merge(adapters, (adapter) => adapter.listPermissions?.(directory)) as AgentPermission[])
          .find((item) => item.id === permissionId)
        const adapter = permission
          ? await adapterForSession(permission.sessionID, directory)
          : [...adapters.values()].find((item) => item.respondPermission)
        if (!adapter?.respondPermission) throw new Error("No registered harness supports permissions")
        const result = await adapter.respondPermission(permissionId, decision, directory)
        publishInteractionEvents(result?.events, directory)
        return result
      },
    },
    questions: {
      async list(directory: RuntimeDirectory): Promise<AgentQuestion[]> {
        return merge(adapters, (adapter) => adapter.listQuestions?.(directory)) as Promise<AgentQuestion[]>
      },
      async answer(questionId: string, answer: string, directory: RuntimeDirectory): Promise<AgentRuntimeInteractionResult | void> {
        const question = (await merge(adapters, (adapter) => adapter.listQuestions?.(directory)) as AgentQuestion[])
          .find((item) => item.id === questionId)
        const adapter = question
          ? await adapterForSession(question.sessionID, directory)
          : [...adapters.values()].find((item) => item.replyQuestion)
        if (!adapter?.replyQuestion) throw new Error("No registered harness supports questions")
        const result = await adapter.replyQuestion(questionId, answer, directory)
        publishInteractionEvents(result?.events, directory)
        return result
      },
      async reject(questionId: string, directory: RuntimeDirectory): Promise<AgentRuntimeInteractionResult | void> {
        const question = (await merge(adapters, (adapter) => adapter.listQuestions?.(directory)) as AgentQuestion[])
          .find((item) => item.id === questionId)
        const adapter = question
          ? await adapterForSession(question.sessionID, directory)
          : [...adapters.values()].find((item) => item.rejectQuestion)
        if (!adapter?.rejectQuestion) throw new Error("No registered harness supports questions")
        const result = await adapter.rejectQuestion(questionId, directory)
        publishInteractionEvents(result?.events, directory)
        return result
      },
    },
    todos: {
      async list(sessionId: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId, directory)
        if (!adapter.getTodos) return []
        return await adapter.getTodos(sessionId, directory)
      },
    },
    commands: {
      async list(directory: RuntimeDirectory) {
        return merge(adapters, (adapter) => adapter.listCommands?.(directory))
      },
      async execute(sessionId: string, command: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId, directory)
        if (!adapter.executeCommand) throw new Error("This harness does not support commands")
        return await adapter.executeCommand(sessionId, command, directory)
      },
    },
    config: {
      async read(sessionId: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId, directory)
        return await adapter.getSessionConfig(sessionId, directory)
      },
      async update(sessionId: string, update: SessionConfigUpdate, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId, directory)
        return await adapter.updateSessionConfig(sessionId, update, directory)
      },
      async options(directory: RuntimeDirectory) {
        return merge(adapters, (adapter) => adapter.probeConfigOptions?.(directory))
      },
    },
    health: {
      read(directory: RuntimeDirectory): AgentRuntimeHealth[] {
        return [...adapters.values()]
          .map((adapter) => adapter.readRuntimeHealth?.(directory))
          .filter((item): item is AgentRuntimeHealth => !!item)
      },
    },
    capabilities: {
      async read(sessionId: string, directory?: RuntimeDirectory): Promise<HarnessCapabilities> {
        const adapter = await adapterForSession(sessionId, directory)
        return await adapter.readHarnessCapabilities(directory, { sessionId })
      },
    },
    dispose() {
      for (const subscriber of subscribers) subscriber.close()
      for (const adapter of adapters.values()) adapter.dispose()
      store.close?.()
    },
  }
}

function key(input: Pick<SessionHarness, "id" | "access">) {
  return `${input.id}:${input.access}`
}

async function merge<T>(adapters: Map<string, AgentHarnessAdapter>, read: (adapter: AgentHarnessAdapter) => Promise<T[]> | undefined) {
  const out: T[] = []
  for (const adapter of adapters.values()) {
    const rows = await read(adapter)
    if (rows) out.push(...rows)
  }
  return out
}

function subscription(
  subscribers: Set<Subscriber>,
  input: AgentRuntimeSubscribeInput,
  eventDelivery?: AgentRuntimeEventDeliveryPolicy,
): AsyncIterable<AgentRuntimeEventEnvelope> {
  const queue: AgentRuntimeEventEnvelope[] = []
  const resolvers: Array<(result: IteratorResult<AgentRuntimeEventEnvelope>) => void> = []
  let closed = false
  const finish = () => {
    closed = true
    subscribers.delete(subscriber)
    for (const resolve of resolvers.splice(0)) resolve({ done: true, value: undefined })
  }
  const subscriber: Subscriber = {
    input,
    push(event) {
      if (closed) return
      const resolve = resolvers.shift()
      if (resolve) {
        resolve({ done: false, value: event })
        return
      }
      queue.push(event)
    },
    close() {
      finish()
    },
  }
  subscribers.add(subscriber)
  const nextEvent = (): Promise<IteratorResult<AgentRuntimeEventEnvelope>> => {
    if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift()! })
    if (closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => resolvers.push(resolve))
  }
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AgentRuntimeEventEnvelope>> {
          while (true) {
            const next = await nextEvent()
            if (next.done || !eventDelivery || !input.identity) return next
            const decision = await eventDelivery({ identity: input.identity, event: next.value })
            if (decision === "deliver") return next
            if (decision === "terminate") {
              finish()
              return { done: true, value: undefined }
            }
          }
        },
        return(): Promise<IteratorResult<AgentRuntimeEventEnvelope>> {
          finish()
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}
