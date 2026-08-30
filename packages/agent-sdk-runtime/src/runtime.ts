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
import { buildSession, buildUserMessage, eventSessionId, messagePartUpdated, messageUpdated, sessionIdle, sessionUpdated, toCompatEvent, type CompatEvent } from "./compat-events"
import { createTurnEventProjector } from "./harnesses/shared/turn-projection"
import { createChildEventRouter } from "./harnesses/shared/child-event-routing"
import { createRuntimeEventHub, type RuntimeEventHub } from "./runtime-event-hub"
import type { AgentRuntimeStoreWithRecovery } from "./harnesses/shared/runtime-store"
import { deriveSessionTitle, extractPromptTitleText, hasConcreteSessionTitle } from "./session-title"
import { resolveSessionModel } from "./session-model"
import { createRuntimeSubscription, type RuntimeSubscriber } from "./runtime/subscription"
import { isTerminalRuntimePayload, mergeOutcome, outcomeFromPayload } from "./runtime/turn-outcome"

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
  subscriberBufferSize?: number
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

export class AgentRuntimeTurnAdmissionError extends Error {
  readonly code = "turn_already_active"

  constructor(readonly sessionId: string) {
    super("Session is already processing a message")
    this.name = "AgentRuntimeTurnAdmissionError"
  }
}

export function isAgentRuntimeTurnAdmissionError(error: unknown): error is AgentRuntimeTurnAdmissionError {
  return error instanceof AgentRuntimeTurnAdmissionError || (
    !!error && typeof error === "object" &&
    (error as { code?: unknown }).code === "turn_already_active"
  )
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
  const resolvingAdapters = new Map<string, Promise<AgentHarnessAdapter>>()
  const subscribers = new Set<RuntimeSubscriber>()
  // Prompt admission belongs to the runtime, not to a downstream harness
  // iterator. Claim the session before persisting the user/assistant rows so a
  // rejected concurrent prompt cannot manufacture a failed turn or overwrite
  // the status of the turn that is actually running.
  const activeTurnAdmissions = new Map<string, object>()

  const adapterFor = async (harness: SessionHarness) => {
    const harnessKey = key(harness)
    const existing = adapters.get(harnessKey)
    if (existing) return existing
    if (!input.resolveHarness) throw new Error(`No harness registered for ${harness.id}:${harness.access}`)
    const pending = resolvingAdapters.get(harnessKey)
    if (pending) return await pending
    const resolution = Promise.resolve()
      .then(() => input.resolveHarness!(harness))
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

  const runTurn = async (
    sessionId: string,
    prompt: PromptInput,
    directory: RuntimeDirectory,
    adapter: AgentHarnessAdapter,
    admission: object,
    clearsHandoff = false,
  ) => {
    const ownsAdmission = () => activeTurnAdmissions.get(sessionId) === admission
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
      onRuntimeEvent: (event) => {
        if (!ownsAdmission()) return
        publish({
          sessionId: event.sessionId,
          directory: event.directory,
          payload: event.payload,
        })
      },
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
        onRuntimeEvent: (event) => {
          if (!ownsAdmission()) return
          publish({
            sessionId: event.sessionId,
            directory: event.directory,
            payload: event.payload,
          })
        },
      }),
      onDiagnostic: (payload) => {
        if (ownsAdmission()) publish({ sessionId, directory, payload })
      },
    })
    const maybeEmitTitle = async () => {
      if (!ownsAdmission()) return
      if (titleEmitted) return
      titleEmitted = true
      const session = store.getSession(sessionId) as { title?: string | null; time?: { created?: number } } | null
      if (hasConcreteSessionTitle(session?.title)) return
      const text = extractPromptTitleText(prompt.parts)
      if (!text) return
      const title = deriveSessionTitle(text)
      await adapter.updateSession(sessionId, { title }, directory)
      if (!ownsAdmission()) return
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
        // An acknowledged abort may release this session for a replacement
        // turn before a misbehaving adapter closes its old iterator. Fence all
        // late events from that superseded generation.
        if (!ownsAdmission()) return
        terminal ||= isTerminalRuntimePayload(payload)
        outcome = mergeOutcome(outcome, outcomeFromPayload(payload))
        // A failed turn has one authoritative terminal publication path below.
        // Publishing a provider terminal first makes the UI clear its working
        // state before the store has committed the assistant error row.
        if (outcome?.status === "failed" && isTerminalRuntimePayload(payload)) continue
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
      if (!ownsAdmission()) return
      await maybeEmitTitle()
      if (!ownsAdmission()) return
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
      const finished = store.finishTurn({
        sessionId,
        assistantMessageId: prompt.assistantMessageId,
        outcome: outcome ?? { status: "completed", completedAt: Date.now() },
      })
      for (const payload of finished.events) publish({ sessionId, directory, payload })
      if (clearsHandoff && outcome?.status === "completed") store.updateSessionConfig(sessionId, { handoff: null })
    } catch (err) {
      if (!ownsAdmission()) return
      const message = err instanceof Error ? err.message : "turn failed"
      const finished = store.finishTurn({
        sessionId,
        assistantMessageId: prompt.assistantMessageId,
        outcome: { status: "failed", completedAt: Date.now(), error: message },
      })
      for (const payload of finished.events) publish({ sessionId, directory, payload })
    } finally {
      router.dispose()
    }
  }

  const updateSessionConfig = async (
    sessionId: string,
    update: SessionConfigUpdate,
    directory?: RuntimeDirectory,
  ) => {
    const current = store.getSessionConfig(sessionId)
    const changingHarness = !!current && !!update.harness && key(current.harness) !== key(update.harness)
    if (!changingHarness) {
      const adapter = await adapterForSession(sessionId, directory)
      const configured = await adapter.updateSessionConfig(sessionId, update, directory)
      const persisted = store.updateSessionConfig(sessionId, configured)
      if (!persisted) throw new Error(`Session ${sessionId} has no runtime config`)
      return persisted
    }
    const session = store.getSession(sessionId) as { title?: string | null; status?: string | null; directory?: string } | null
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (session.status === "busy") throw new Error("Wait for the current turn to finish before switching harness")
    const previousAgentSessionId = store.getAgentSessionId(sessionId)
    if (!previousAgentSessionId) throw new Error(`Session ${sessionId} has no native harness session`)
    const previousOwnerKey = store.getSessionOwnerKey?.(sessionId) ?? null
    const targetDirectory = directory ?? session.directory
    const source = await adapterFor(current!.harness)
    const transcript = renderSessionHandoff(
      await source.getMessages(sessionId, targetDirectory),
      current!.harness,
    )
    const target = await adapterFor(update.harness!)
    if (!target.createHandoffSession) throw new Error(`Harness ${update.harness!.id} does not support conversation handoff`)
    try {
      const created = await target.createHandoffSession(
        targetDirectory,
        session.title ?? undefined,
        sessionId,
        { system: transcript },
      )
      store.bindSession({
        sessionId,
        directory: runtimeDirectory(targetDirectory),
        title: session.title ?? undefined,
        agentSessionId: created.agentSessionId ?? created.id,
        ownerKey: created.ownerKey ?? null,
      })
      const configured = await target.updateSessionConfig(sessionId, {
        ...update,
        ...(update.model === undefined ? { model: null } : {}),
        ...(update.variant === undefined ? { variant: null } : {}),
        ...(update.agent === undefined ? { agent: null } : {}),
      }, targetDirectory)
      const next = store.updateSessionConfig(sessionId, {
        ...configured,
        harness: update.harness!,
        model: configured.model ?? null,
        variant: configured.variant ?? null,
        agent: configured.agent ?? null,
        handoff: { from: current!.harness, pending: true, transcript },
      })!
      const markerId = `handoff-${randomUUID()}`
      const createdAt = Date.now()
      const markerModel = configured.model ?? {
        providerID: update.harness!.id,
        modelID: "default",
      }
      commitAndPublish(sessionId, targetDirectory, messageUpdated(buildUserMessage({
        id: markerId,
        sessionID: sessionId,
        agent: configured.agent ?? "build",
        model: markerModel,
        created: createdAt,
      })), { dir: "out", method: "session/handoff" })
      commitAndPublish(sessionId, targetDirectory, messagePartUpdated({
        id: `${markerId}-part`,
        sessionID: sessionId,
        messageID: markerId,
        type: "handoff",
        from: current!.harness,
        to: update.harness!,
      }), { dir: "out", method: "session/handoff" })
      return next
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
  }

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
        const updated = await adapter.updateSession(sessionId, updates, directory) as AgentSession | null
        if (!updated) throw new Error(`Session ${sessionId} not found`)
        const persisted = store.updateSession(sessionId, {
          ...(updated.title !== undefined ? { title: updated.title ?? undefined } : {}),
          ...(updated.time?.archived !== undefined ? { time: { archived: updated.time.archived } } : {}),
        })
        if (!persisted) throw new Error(`Session ${sessionId} not found`)
        return persisted as AgentSession
      },
      async updateConfig(sessionId: string, update: SessionConfigUpdate, directory?: RuntimeDirectory) {
        return await updateSessionConfig(sessionId, update, directory)
      },
      async delete(sessionId: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId, directory)
        await adapter.deleteSession(sessionId, directory)
        store.deleteSession(sessionId)
      },
    },
    turns: {
      async start(turn: AgentRuntimeTurnStartInput): Promise<AgentRuntimeTurnStartResult> {
        const session = store.getSession(turn.sessionId) as { directory?: string } | null
        if (!session) throw new Error(`Session ${turn.sessionId} not found`)
        const storedConfig = store.getSessionConfig(turn.sessionId)
        const directory = session.directory ?? undefined
        const adapter = await adapterForSession(turn.sessionId, directory)
        const config = storedConfig ?? await adapter.getSessionConfig(turn.sessionId, directory)
        const userMessageId = turn.messageId ?? `msg_${randomUUID()}`
        const assistantMessageId = turn.assistantMessageId ?? `${userMessageId}_r`
        const handoff = config?.handoff?.pending ? config.handoff.transcript : undefined
        const prompt: PromptInput = {
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
        }
        if (activeTurnAdmissions.has(turn.sessionId)) {
          throw new AgentRuntimeTurnAdmissionError(turn.sessionId)
        }
        const admission = {}
        activeTurnAdmissions.set(turn.sessionId, admission)
        try {
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
          void runTurn(turn.sessionId, prompt, directory, adapter, admission, !!handoff)
            .finally(() => {
              if (activeTurnAdmissions.get(turn.sessionId) === admission) {
                activeTurnAdmissions.delete(turn.sessionId)
              }
            })
        } catch (error) {
          if (activeTurnAdmissions.get(turn.sessionId) === admission) {
            activeTurnAdmissions.delete(turn.sessionId)
          }
          throw error
        }
        return { sessionId: turn.sessionId, userMessageId, assistantMessageId, directory, prompt }
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
          // The runtime owns cancellation completion. Some adapters terminate
          // their stream after acknowledging abort, while a stuck adapter may
          // never yield again. Publish the canonical terminal frame before
          // releasing admission so route-level subscribers always settle and
          // any later adapter frames remain fenced as the old generation.
          publish({ sessionId, directory, payload: { type: "finish", sessionId } })
          activeTurnAdmissions.delete(sessionId)
        }
        return result
      },
    },
    events: {
      subscribe(subscribe: AgentRuntimeSubscribeInput = {}) {
        return createRuntimeSubscription(subscribers, subscribe, input.subscriberBufferSize ?? 256)
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
        if (!permission) throw new Error(`Permission ${permissionId} not found`)
        const adapter = await adapterForSession(permission.sessionID, directory)
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
        if (!question) throw new Error(`Question ${questionId} not found`)
        const adapter = await adapterForSession(question.sessionID, directory)
        if (!adapter?.replyQuestion) throw new Error("No registered harness supports questions")
        const result = await adapter.replyQuestion(questionId, answer, directory)
        publishInteractionEvents(result?.events, directory)
        return result
      },
      async reject(questionId: string, directory: RuntimeDirectory): Promise<AgentRuntimeInteractionResult | void> {
        const question = (await merge(adapters, (adapter) => adapter.listQuestions?.(directory)) as AgentQuestion[])
          .find((item) => item.id === questionId)
        if (!question) throw new Error(`Question ${questionId} not found`)
        const adapter = await adapterForSession(question.sessionID, directory)
        if (!adapter?.rejectQuestion) throw new Error("No registered harness supports questions")
        const result = await adapter.rejectQuestion(questionId, directory)
        publishInteractionEvents(result?.events, directory)
        return result
      },
    },
    todos: {
      async list(sessionId: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId, directory)
        if (!adapter.getTodos) throw new Error("This harness does not support todos")
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
        return await updateSessionConfig(sessionId, update, directory)
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
      activeTurnAdmissions.clear()
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
