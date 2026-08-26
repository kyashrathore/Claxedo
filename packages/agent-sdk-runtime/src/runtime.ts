import { randomUUID } from "crypto"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
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
  AgentTurnOutcome,
} from "./index"
import type { AgentHarnessAdapter } from "./adapter-contract"
import { renderSessionHandoff } from "./session-handoff"
import { hasAdapterCapability } from "./capabilities"
import { buildSession, eventSessionId, sessionError, sessionIdle, sessionUpdated, toCompatEvent, type CompatEvent } from "./compat-events"
import { createTurnEventProjector } from "./harnesses/shared/turn-projection"
import { createChildEventRouter } from "./harnesses/shared/child-event-routing"
import { createRuntimeEventHub, type RuntimeEventHub } from "./runtime-event-hub"
import type { AgentRuntimeStoreWithRecovery } from "./harnesses/shared/runtime-store"
import { extractPromptTitleText, fallbackSessionTitle, hasConcreteSessionTitle } from "./session-title"

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
}

export type AgentRuntimeEventEnvelope = {
  sessionId: string
  directory: RuntimeDirectory
  payload: AgentRuntimeStreamEvent
}

export type AgentRuntimeSubscribeInput = {
  sessionId?: string
  directory?: RuntimeDirectory
}

export type AgentRuntimeSessionCreateInput = {
  id?: string
  directory: RuntimeDirectory
  harness: SessionHarness
  model?: PromptModel
  variant?: string | null
  agent?: string | null
  title?: string
}

export type AgentRuntimeTurnStartInput = {
  sessionId: string
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
}

export type AgentRuntimeTurnStartResult = {
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  directory: RuntimeDirectory
  prompt: PromptInput
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

function isProjectableRuntimeEvent(payload: AgentRuntimeStreamEvent): payload is AgentRuntimeEvent {
  return !toCompatEvent(payload) && payload.type !== "server.heartbeat"
}

export function createAgentRuntime(input: CreateAgentRuntimeInput) {
  const eventHub = createRuntimeEventHub()
  const store = input.store as unknown as RuntimeStoreInternal
  const factories = input.harnesses as unknown as InternalAgentHarnessFactory[]
  const adapters = new Map(factories.map((factory) => [
    key(factory),
    factory.create({ store, eventHub }),
  ]))
  const subscribers = new Set<Subscriber>()

  const adapterFor = (harness: Pick<SessionHarness, "id" | "access">) => {
    const adapter = adapters.get(key(harness))
    if (!adapter) throw new Error(`No harness registered for ${harness.id}:${harness.access}`)
    return adapter
  }

  const adapterForSession = async (sessionId: string, directory: RuntimeDirectory) => {
    const config = store.getSessionConfig(sessionId)
    if (!config && adapters.size === 1) return adapters.values().next().value!
    if (!config) throw new Error(`Session ${sessionId} has no runtime config`)
    return adapterFor(config.harness)
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
    payload: AgentRuntimeStreamEvent,
    source: { dir: "in" | "out"; method: string },
  ) => {
    const compat = toCompatEvent(payload)
    if (!compat) {
      publish({ sessionId, directory, payload })
      return payload
    }
    const agentSessionId = store.getAgentSessionId(sessionId) ?? undefined
    const committed = store.appendEvent({
      sessionId,
      ...(agentSessionId ? { agentSessionId } : {}),
      payload: compat,
      source,
    }).payload
    publish({ sessionId, directory, payload: committed })
    return committed
  }

  const runTurn = async (sessionId: string, prompt: PromptInput, directory: RuntimeDirectory, adapter: AgentHarnessAdapter, clearsHandoff = false) => {
    let outcome: AgentTurnOutcome | undefined
    let titleEmitted = false
    const stableAssistantMessageId = prompt.assistantMessageId ?? `${prompt.userMessageId}_r`
    const assistantAliases = new Map<string, string>()
    const normalizeCompatEvent = (event: CompatEvent): CompatEvent => {
      if (event.type === "message.updated" && event.properties.info.role === "assistant") {
        const info = event.properties.info
        if (info.id !== stableAssistantMessageId && info.parentID === prompt.userMessageId) {
          assistantAliases.set(info.id, stableAssistantMessageId)
          return {
            ...event,
            properties: {
              ...event.properties,
              info: { ...info, id: stableAssistantMessageId },
            },
          } as CompatEvent
        }
      }
      if (event.type === "message.part.updated") {
        if (
          event.properties.part.messageID !== stableAssistantMessageId &&
          event.properties.part.messageID !== prompt.userMessageId
        ) {
          assistantAliases.set(event.properties.part.messageID, stableAssistantMessageId)
        }
        const alias = assistantAliases.get(event.properties.part.messageID)
        if (alias) {
          return {
            ...event,
            properties: {
              ...event.properties,
              messageID: alias,
              part: { ...event.properties.part, messageID: alias },
            },
          } as CompatEvent
        }
      }
      if (event.type === "message.part.delta") {
        if (event.properties.messageID !== stableAssistantMessageId && event.properties.messageID !== prompt.userMessageId) {
          assistantAliases.set(event.properties.messageID, stableAssistantMessageId)
        }
        const alias = assistantAliases.get(event.properties.messageID)
        if (alias) {
          return {
            ...event,
            properties: { ...event.properties, messageID: alias },
          } as CompatEvent
        }
      }
      if (event.type === "message.completed") {
        if (event.properties.messageID !== stableAssistantMessageId && event.properties.messageID !== prompt.userMessageId) {
          assistantAliases.set(event.properties.messageID, stableAssistantMessageId)
        }
        const alias = assistantAliases.get(event.properties.messageID)
        if (alias) {
          return {
            ...event,
            properties: { ...event.properties, messageID: alias },
          } as CompatEvent
        }
      }
      if (event.type === "session.usage") {
        // Usage emitted by the active parent turn belongs to the submitted
        // assistant message even when a provider reports usage before its
        // message metadata (ACP does this). Waiting for an observed provider
        // alias creates a second, provisional metering fact keyed by the raw
        // provider id. Child-session usage keeps its own identity.
        if (event.properties.sessionID === sessionId) {
          return {
            ...event,
            properties: { ...event.properties, messageID: stableAssistantMessageId },
          } as CompatEvent
        }
      }
      return event
    }
    const parentProjector = createTurnEventProjector({
      store,
      owner: {
        sessionId,
        getAgentSessionId: () => store.getAgentSessionId(sessionId) ?? sessionId,
      },
      directory: runtimeDirectory(directory),
      input: prompt,
      assistantMessageId: stableAssistantMessageId,
      created: Date.now(),
      onEvent: () => {},
      onRuntimeEvent: (event) => publish({
        sessionId: event.sessionId,
        directory: event.directory,
        payload: event.payload,
      }),
    })
    const router = createChildEventRouter({
      parent: parentProjector,
      createChildProjector: (target) => createTurnEventProjector({
        store,
        owner: {
          sessionId: target.sessionId,
          getAgentSessionId: target.getAgentSessionId,
        },
        directory: runtimeDirectory(directory),
        input: target.input,
        assistantMessageId: target.assistantMessageId,
        created: target.created,
        onEvent: () => {},
        onRuntimeEvent: (event) => publish({
          sessionId: event.sessionId,
          directory: event.directory,
          payload: event.payload,
        }),
      }),
      onDiagnostic: (payload) => publish({ sessionId, directory, payload }),
    })
    const maybeEmitTitle = async () => {
      if (titleEmitted) return
      titleEmitted = true
      const session = store.getSession(sessionId) as { title?: string | null; time?: { created?: number } } | null
      if (hasConcreteSessionTitle(session?.title)) return
      const text = extractPromptTitleText(prompt.parts)
      if (!text) return
      const title = fallbackSessionTitle(text)
      await adapter.updateSession(sessionId, { title }, directory)
      commitAndPublish(sessionId, directory, sessionUpdated(buildSession({
        id: sessionId,
        directory: runtimeDirectory(directory),
        title,
        created: session?.time?.created,
        updated: Date.now(),
      })), { dir: "in", method: "auto-title" })
    }
    try {
      let terminal = false
      for await (const payload of adapter.sendMessage(sessionId, prompt, directory)) {
        terminal ||= isTerminalRuntimePayload(payload)
        outcome = mergeOutcome(outcome, outcomeFromPayload(payload))
        const compat = toCompatEvent(payload)
        if (compat) {
          if (compat.type === "session.idle") await maybeEmitTitle()
          if (adapter.commitsStreamEvents) {
            publish({ sessionId, directory, payload: normalizeCompatEvent(compat) })
          } else {
            commitAndPublish(sessionId, directory, normalizeCompatEvent(compat), { dir: "in", method: "sendMessage" })
          }
          continue
        }
        if (isProjectableRuntimeEvent(payload)) {
          router.project(payload, { dir: "in", method: "sendMessage" })
          continue
        }
        publish({ sessionId, directory, payload })
      }
      await maybeEmitTitle()
      if (!terminal) {
        const payload = sessionIdle(sessionId)
        outcome = mergeOutcome(outcome, outcomeFromPayload(payload))
        commitAndPublish(sessionId, directory, payload, { dir: "out", method: "runtime.finish" })
      }
      // Terminal compat events and the durable turn outcome are separate
      // contracts. A committing adapter may already have journaled
      // message.completed/session.idle, but only finishTurn records the
      // replayable turn.finish outcome. Stores make this call idempotent and
      // avoid duplicating terminal events that the adapter already committed.
      store.finishTurn?.({
        sessionId,
        assistantMessageId: prompt.assistantMessageId,
        outcome: outcome ?? { status: "completed", completedAt: Date.now() },
      })
      if (clearsHandoff && outcome?.status === "completed") store.updateSessionConfig(sessionId, { handoff: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : "turn failed"
      const payload = sessionError(message, sessionId)
      commitAndPublish(sessionId, directory, payload, { dir: "out", method: "runtime.error" })
      store.finishTurn?.({
        sessionId,
        assistantMessageId: prompt.assistantMessageId,
        outcome: { status: "failed", completedAt: Date.now(), error: message },
      })
    } finally {
      router.dispose()
    }
  }

  return {
    sessions: {
      async create(create: AgentRuntimeSessionCreateInput): Promise<AgentSession> {
        const adapter = adapterFor(create.harness)
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
        const live = await adapterFor(config.harness).getSession(sessionId, directory) as AgentSession | null
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
        return await adapter.updateSession(sessionId, updates, directory) as AgentSession | null
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
        const previousAgentSessionId = store.getAgentSessionId(sessionId)
        if (!previousAgentSessionId) throw new Error(`Session ${sessionId} has no native harness session`)
        const previousOwnerKey = store.getSessionOwnerKey?.(sessionId) ?? null
        const target = adapterFor(update.harness!)
        if (!target.createHandoffSession) throw new Error(`Harness ${update.harness!.id} does not support conversation handoff`)
        const targetDirectory = directory ?? session.directory
        try {
          const created = await target.createHandoffSession(targetDirectory, session.title ?? undefined, sessionId)
          store.bindSession({
            sessionId,
            directory: runtimeDirectory(targetDirectory),
            title: session.title ?? undefined,
            agentSessionId: created.agentSessionId ?? created.id,
            ownerKey: created.ownerKey ?? null,
          })
          const configured = await target.updateSessionConfig(sessionId, {
            ...update,
            // Source-harness choices are never valid target-harness state.
            // The caller may provide target choices atomically; otherwise the
            // target starts from its defaults and the next prompt carries the
            // selections made by the target harness UI.
            ...(update.model === undefined ? { model: null } : {}),
            ...(update.variant === undefined ? { variant: null } : {}),
            ...(update.agent === undefined ? { agent: null } : {}),
          }, targetDirectory)
          return store.updateSessionConfig(sessionId, {
            ...configured,
            harness: update.harness!,
            model: configured.model ?? null,
            variant: configured.variant ?? null,
            agent: configured.agent ?? null,
            handoff: { from: current!.harness, pending: true },
          })!
        } catch (error) {
          store.bindSession({
            sessionId,
            directory: runtimeDirectory(session.directory),
            title: session.title ?? undefined,
            agentSessionId: previousAgentSessionId,
            ownerKey: previousOwnerKey,
          })
          store.updateSessionConfig(sessionId, {
            harness: current!.harness,
            model: current!.model ?? null,
            variant: current!.variant ?? null,
            agent: current!.agent ?? null,
            handoff: current!.handoff ?? null,
          })
          throw error
        }
      },
      async delete(sessionId: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId, directory)
        await adapter.deleteSession(sessionId, directory)
      },
    },
    turns: {
      async start(turn: AgentRuntimeTurnStartInput): Promise<AgentRuntimeTurnStartResult> {
        const session = store.getSession(turn.sessionId) as { directory?: string } | null
        if (!session) throw new Error(`Session ${turn.sessionId} not found`)
        const config = store.getSessionConfig(turn.sessionId)
        const directory = session.directory ?? undefined
        const adapter = await adapterForSession(turn.sessionId, directory)
        const userMessageId = turn.messageId ?? `msg_${randomUUID()}`
        const assistantMessageId = turn.assistantMessageId ?? `${userMessageId}_r`
        const handoff = config?.handoff?.pending ? renderSessionHandoff(store.getMessages(turn.sessionId), config.handoff.from) : undefined
        const prompt: PromptInput = {
          parts: turn.parts ?? (turn.text ? [{ type: "text", text: turn.text }] : []),
          userMessageId,
          assistantMessageId,
          agent: turn.agent ?? config?.agent ?? "build",
          model: turn.model ?? config?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
          ...(turn.tools ? { tools: turn.tools } : {}),
          ...(turn.format ? { format: turn.format } : {}),
          ...(handoff || turn.system ? { system: [handoff, turn.system].filter(Boolean).join("\n\n") } : {}),
          ...(turn.permissionMode ? { permissionMode: turn.permissionMode } : {}),
          ...(turn.variant !== undefined ? { variant: turn.variant } : config?.variant ? { variant: config.variant } : {}),
        }
        const agentSessionId = store.getAgentSessionId(turn.sessionId) ?? undefined
        const started = store.startTurn({
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
        })
        for (const payload of started?.events ?? []) {
          publish({ sessionId: turn.sessionId, directory, payload })
        }
        void runTurn(turn.sessionId, prompt, directory, adapter, !!handoff)
        return { sessionId: turn.sessionId, userMessageId, assistantMessageId, directory, prompt }
      },
      async abort(sessionId: string, directory?: RuntimeDirectory): Promise<AgentRuntimeAbortResult> {
        const adapter = await adapterForSession(sessionId, directory)
        if (!adapter.abort) throw new Error("This harness does not support abort")
        const result = await adapter.abort(sessionId, directory)
        if (result.ok && result.status === "cancelled") {
          store.finishTurn?.({
            sessionId,
            outcome: { status: "cancelled", completedAt: Date.now(), reason: "abort" },
          })
        }
        return result
      },
    },
    events: {
      subscribe(subscribe: AgentRuntimeSubscribeInput = {}) {
        return subscription(subscribers, subscribe)
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

function isTerminalRuntimePayload(payload: AgentRuntimeStreamEvent) {
  if ("properties" in payload) return payload.type === "session.idle" || payload.type === "session.error"
  return payload.type === "finish" || payload.type === "error" || payload.type === "session-status" && payload.status === "error"
}

function outcomeFromPayload(payload: AgentRuntimeStreamEvent): AgentTurnOutcome | undefined {
  if ("properties" in payload) {
    if (payload.type === "session.idle") return { status: "completed", completedAt: Date.now() }
    if (payload.type === "session.error") return { status: "failed", completedAt: Date.now(), error: compatErrorMessage(payload.properties.error) }
    return
  }
  if (payload.type === "finish") return { status: "completed", completedAt: Date.now() }
  if (payload.type === "session-status" && payload.status === "idle") return { status: "completed", completedAt: Date.now() }
  if (payload.type === "session-status" && payload.status === "error") return { status: "failed", completedAt: Date.now(), error: "session error" }
  if (payload.type === "error") return { status: "failed", completedAt: Date.now(), error: payload.error }
}

function mergeOutcome(prev: AgentTurnOutcome | undefined, next: AgentTurnOutcome | undefined) {
  if (!next) return prev
  if (!prev) return next
  if (prev.status === "failed" && next.status === "failed" && prev.error === "session error" && next.error) {
    return { ...prev, error: next.error }
  }
  if (prev.status === "failed" || prev.status === "cancelled") return prev
  if (next.status === "failed" || next.status === "cancelled") return next
  return prev
}

function compatErrorMessage(input: unknown) {
  if (!input || typeof input !== "object") return "session error"
  const row = input as { data?: unknown; message?: unknown }
  const data = row.data && typeof row.data === "object" ? row.data as { message?: unknown } : undefined
  return typeof data?.message === "string"
    ? data.message
    : typeof row.message === "string"
    ? row.message
    : "session error"
}

function subscription(subscribers: Set<Subscriber>, input: AgentRuntimeSubscribeInput): AsyncIterable<AgentRuntimeEventEnvelope> {
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
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<AgentRuntimeEventEnvelope>> {
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift()! })
          if (closed) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve) => resolvers.push(resolve))
        },
        return(): Promise<IteratorResult<AgentRuntimeEventEnvelope>> {
          finish()
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}
