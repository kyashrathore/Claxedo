import { randomUUID } from "crypto"
import { agentRuntimeEvent, type AgentRuntimeEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
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
import type { AgentGoalMutationResult, AgentGoalResource, AgentHarnessAdapter } from "./adapter-contract"
import { requireGoalResource } from "./adapter-contract"
import { renderSessionHandoff } from "./session-handoff"
import { GoalCapabilityError, hasAdapterCapability, requireGoalAction, type GoalAction, type GoalCapabilities } from "./capabilities"
import { buildSession, buildUserMessage, eventSessionId, messagePartUpdated, messageUpdated, sessionIdle, sessionUpdated, toCompatEvent, type CompatEvent } from "./compat-events"
import { createTurnEventProjector } from "./harnesses/shared/turn-projection"
import { createChildEventRouter } from "./harnesses/shared/child-event-routing"
import { createRuntimeEventHub, type RuntimeEventHub } from "./runtime-event-hub"
import type { AgentRuntimeStoreWithRecovery } from "./harnesses/shared/runtime-store"
import { deriveSessionTitle, extractPromptTitleText, hasConcreteSessionTitle } from "./session-title"
import { resolveSessionModel } from "./session-model"
import { createRuntimeSubscription, type RuntimeSubscriber } from "./runtime/subscription"
import { isTerminalRuntimePayload, mergeOutcome, outcomeFromPayload } from "./runtime/turn-outcome"
import { turnStartRecord } from "./runtime/turn-record"

export {
  AGENT_RUNTIME_TURN_CONFLICT_CODE,
  AgentRuntimeGoalError,
  AgentRuntimeTurnAdmissionError,
  AgentRuntimeTurnAdmissionError as AgentRuntimeTurnConflictError,
  isAgentRuntimeGoalError,
  isAgentRuntimeTurnAdmissionError,
  isAgentRuntimeTurnAdmissionError as isAgentRuntimeTurnConflictError,
} from "./runtime/contracts"
export type {
  AgentHarnessFactory,
  AgentRuntimeAbortResult,
  AgentRuntimeEventDeliveryPolicy,
  AgentRuntimeEventEnvelope,
  AgentRuntimeGoalErrorCode,
  AgentRuntimeSubscriptionIdentity,
  AgentRuntimeGoalStartInput,
  AgentRuntimeHealth,
  AgentRuntimeInteractionResult,
  AgentRuntimePermissionDecision,
  AgentRuntimeSessionCreateInput,
  AgentRuntimeStore,
  AgentRuntimeSubscribeInput,
  AgentRuntimeTurnStartInput,
  AgentRuntimeTurnStartResult,
  CreateAgentRuntimeInput,
} from "./runtime/contracts"
import {
  AgentRuntimeGoalError,
  AgentRuntimeTurnAdmissionError,
} from "./runtime/contracts"
import type {
  AgentHarnessFactory,
  AgentRuntimeAbortResult,
  AgentRuntimeEventEnvelope,
  AgentRuntimeGoalStartInput,
  AgentRuntimeHealth,
  AgentRuntimeInteractionResult,
  AgentRuntimePermissionDecision,
  AgentRuntimeSessionCreateInput,
  AgentRuntimeStore,
  AgentRuntimeSubscribeInput,
  AgentRuntimeTurnStartInput,
  AgentRuntimeTurnStartResult,
  CreateAgentRuntimeInput,
  AgentHarnessFactoryContext,
  InternalAgentHarnessFactory,
  RuntimeStoreInternal,
} from "./runtime/contracts"


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
  const activeTurnLeases = new Map<string, string>()
  const goalStartAdmissions = new Map<string, Promise<void>>()

  const withGoalStartAdmission = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = goalStartAdmissions.get(sessionId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(operation)
    const settled = run.then(() => {}, () => {})
    goalStartAdmissions.set(sessionId, settled)
    try {
      return await run
    } finally {
      if (goalStartAdmissions.get(sessionId) === settled) goalStartAdmissions.delete(sessionId)
    }
  }

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

  const sessionDirectory = (sessionId: string): RuntimeDirectory => {
    const session = store.getSession(sessionId) as { directory?: string } | null
    return session?.directory ?? undefined
  }

  /**
   * The store is authoritative for session config, but a session row can exist
   * without one — an adapter bound the session before its config write landed,
   * or the store was hydrated from an older shape. Ask the adapter that owns the
   * session to describe it and write that answer back, so the store stays the
   * authority: the derivation runs once per session and every later read is a
   * plain store hit. A session no adapter can be named for stays a hard error.
   */
  const runtimeForSession = async (
    sessionId: string,
  ): Promise<{ adapter: AgentHarnessAdapter; config: SessionConfig }> => {
    const stored = store.getSessionConfig(sessionId)
    if (stored) return { adapter: await adapterFor(stored.harness), config: stored }
    // Without a persisted harness only a lone registered adapter can be named
    // the owner; picking one of several would be a guess. An id the store never
    // bound is not a config gap — deriving one would write a config row for a
    // session that does not exist, so it stays an unknown session.
    const adapter = store.getSession(sessionId) && adapters.size === 1
      ? adapters.values().next().value
      : undefined
    if (!adapter) throw new Error(`Session ${sessionId} has no runtime config`)
    const derived = await adapter.getSessionConfig(sessionId, sessionDirectory(sessionId))
    return { adapter, config: store.updateSessionConfig(sessionId, derived) ?? derived }
  }

  const configForSession = async (sessionId: string) => (await runtimeForSession(sessionId)).config

  const adapterForSession = async (sessionId: string) => (await runtimeForSession(sessionId)).adapter

  /**
   * An interaction id outlives the listing it came from: the aggregated list is
   * a snapshot, and a session whose stored directory differs in shape from the
   * request's never appears in it at all. Route on the session's own adapter
   * whenever one can be resolved, and otherwise on whichever registered adapter
   * implements the reply — the adapter is the authority on whether the id is
   * still pending, so a listing miss must not make a live interaction
   * unanswerable.
   */
  const interactionAdapter = async (
    method: "respondPermission" | "replyQuestion" | "rejectQuestion",
    sessionId?: string,
  ) => {
    if (sessionId) {
      const scoped = await adapterForSession(sessionId).catch(() => null)
      if (scoped?.[method]) return scoped
    }
    return [...adapters.values()].find((adapter) => adapter[method])
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
    fence?: AgentRuntimeTurnStartInput["admission"],
  ) => {
    if (fence && !fence.valid()) throw new Error("Durable session turn admission is no longer valid")
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
      ...(fence ? { fencingToken: fence.fencingToken() } : {}),
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
    openingUserPublished = false,
    fence?: AgentRuntimeTurnStartInput["admission"],
  ) => {
    const ownsAdmission = () => activeTurnAdmissions.get(sessionId) === admission
    // Two fences guard every producer write for this turn. `ownsAdmission`
    // rejects a superseded in-process generation; `fence` is the host's
    // durable admission, which a takeover elsewhere can invalidate while this
    // instance still owns the in-memory slot.
    const admitted = () => ownsAdmission() && (fence?.valid() ?? true)
    if (!admitted()) return
    // The store already published the opening user message with the turn
    // record; the adapter's own echo of it would fan a duplicate to every
    // subscriber, so exactly one echo is dropped.
    let openingUserAlreadyPublished = openingUserPublished
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
      ...(fence ? { fencingToken: fence.fencingToken() } : {}),
      onEvent: () => {},
      onRuntimeEvent: (event) => {
        if (!admitted()) return
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
        ...(fence ? { fencingToken: fence.fencingToken() } : {}),
        onEvent: () => {},
        onRuntimeEvent: (event) => {
          if (!admitted()) return
          publish({
            sessionId: event.sessionId,
            directory: event.directory,
            payload: event.payload,
          })
        },
      }),
      onDiagnostic: (payload) => {
        if (admitted()) publish({ sessionId, directory, payload })
      },
    })
    const maybeEmitTitle = async () => {
      if (!admitted()) return
      if (titleEmitted) return
      titleEmitted = true
      const session = store.getSession(sessionId) as { title?: string | null; time?: { created?: number } } | null
      if (hasConcreteSessionTitle(session?.title)) return
      const text = extractPromptTitleText(prompt.parts)
      if (!text) return
      const title = deriveSessionTitle(text)
      await adapter.updateSession(sessionId, { title }, directory)
      if (!admitted()) return
      commitAndPublish(sessionId, directory, sessionUpdated(buildSession({
        id: sessionId,
        directory: runtimeDirectory(directory),
        title,
        created: session?.time?.created,
        updated: Date.now(),
      })), { dir: "in", method: "auto-title" }, fence)
    }
    try {
      let terminal = false
      for await (const payload of adapter.sendMessage(
        sessionId,
        prompt,
        directory,
        fence ? { fencingToken: fence.fencingToken() } : undefined,
      )) {
        // An acknowledged abort may release this session for a replacement
        // turn before a misbehaving adapter closes its old iterator. Fence all
        // late events from that superseded generation.
        if (!admitted()) return
        terminal ||= isTerminalRuntimePayload(payload)
        outcome = mergeOutcome(outcome, outcomeFromPayload(payload))
        // A failed turn has one authoritative terminal publication path below.
        // Publishing a provider terminal first makes the UI clear its working
        // state before the store has committed the assistant error row.
        if (outcome?.status === "failed" && isTerminalRuntimePayload(payload)) continue
        const compat = toCompatEvent(payload)
        if (compat) {
          if (
            openingUserAlreadyPublished
            && compat.type === "message.updated"
            && compat.properties.info.role === "user"
            && compat.properties.info.id === prompt.userMessageId
          ) {
            openingUserAlreadyPublished = false
            continue
          }
          if (compat.type === "session.idle") await maybeEmitTitle()
          if (adapter.commitsStreamEvents) {
            publish({ sessionId, directory, payload: normalizeCompatEvent(compat) })
          } else {
            commitAndPublish(sessionId, directory, normalizeCompatEvent(compat), { dir: "in", method: "sendMessage" }, fence)
          }
          continue
        }
        if (isProjectableRuntimeEvent(payload)) {
          router.project(payload, { dir: "in", method: "sendMessage" })
          continue
        }
        publish({ sessionId, directory, payload })
      }
      if (!admitted()) return
      await maybeEmitTitle()
      if (!admitted()) return
      if (!terminal) {
        const payload = sessionIdle(sessionId)
        outcome = mergeOutcome(outcome, outcomeFromPayload(payload))
        commitAndPublish(sessionId, directory, payload, { dir: "out", method: "runtime.finish" }, fence)
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
        ...(fence ? { fencingToken: fence.fencingToken() } : {}),
      })
      for (const payload of finished.events) publish({ sessionId, directory, payload })
      if (clearsHandoff && outcome?.status === "completed") store.updateSessionConfig(sessionId, { handoff: null })
    } catch (err) {
      if (!admitted()) return
      const message = err instanceof Error ? err.message : "turn failed"
      const finished = store.finishTurn({
        sessionId,
        assistantMessageId: prompt.assistantMessageId,
        outcome: { status: "failed", completedAt: Date.now(), error: message },
        ...(fence ? { fencingToken: fence.fencingToken() } : {}),
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
      const adapter = await adapterForSession(sessionId)
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

  const goalResourceReadContext = async (sessionId: string, requestedDirectory?: RuntimeDirectory) => {
    const session = store.getSession(sessionId) as { directory?: string } | null
    if (!session) {
      throw new AgentRuntimeGoalError("goal_session_not_found", `Session ${sessionId} not found`)
    }
    const directory = session.directory ?? undefined
    if (
      requestedDirectory !== undefined &&
      runtimeDirectory(requestedDirectory) !== runtimeDirectory(directory)
    ) {
      throw new AgentRuntimeGoalError("goal_scope_mismatch", `Session ${sessionId} does not belong to this directory`)
    }
    const adapter = await adapterForSession(sessionId)
    const coarse = await adapter.readHarnessCapabilities(directory, { sessionId })
    let resource: AgentGoalResource
    try {
      resource = requireGoalResource(adapter)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Goal resource is unavailable"
      throw new AgentRuntimeGoalError("goal_unavailable", message)
    }
    return { adapter, directory, harness: coarse.harness, resource }
  }

  const goalResourceContext = async (sessionId: string, requestedDirectory?: RuntimeDirectory) => {
    const context = await goalResourceReadContext(sessionId, requestedDirectory)
    const capabilities = await context.resource.readCapabilities(sessionId, context.directory)
    return { ...context, capabilities }
  }

  const availableGoalContext = async (sessionId: string, requestedDirectory?: RuntimeDirectory) => {
    const context = await goalResourceContext(sessionId, requestedDirectory)
    const { capabilities } = context
    if (!capabilities.implemented || !capabilities.available) {
      throw new AgentRuntimeGoalError(
        "goal_unavailable",
        capabilities.unavailableReason ?? `${context.harness} Goal is unavailable`,
      )
    }
    return context
  }

  // One fan-out for every Goal state a subscriber may observe, whichever side
  // produced it: a mutation this runtime performed, or a provider-originated
  // update that reached the event hub. Deduping by snapshot signature — the
  // same policy adapters apply on the hub side — keeps a mutation that is also
  // mirrored onto the hub from publishing the same state twice.
  const publishedGoalSignatures = new Map<string, string>()

  const publishGoalSnapshot = (
    sessionId: string,
    directory: RuntimeDirectory,
    goal: RuntimeGoalSnapshot | null,
  ) => {
    const signature = JSON.stringify(goal ?? null)
    if (publishedGoalSignatures.get(sessionId) === signature) return
    publishedGoalSignatures.set(sessionId, signature)
    publish({
      sessionId,
      directory,
      payload: goal
        ? agentRuntimeEvent.goalUpdated({ sessionId, goal })
        : agentRuntimeEvent.goalCleared({ sessionId }),
    })
  }

  const publishGoalResult = (
    sessionId: string,
    directory: RuntimeDirectory,
    result: AgentGoalMutationResult,
  ) => {
    if (!result.ok) return
    publishGoalSnapshot(sessionId, directory, result.goal ?? null)
  }

  const unsubscribeGoalBridge = eventHub.subscribeRuntime((event) => {
    if (event.payload.type !== "goal-updated" && event.payload.type !== "goal-cleared") return
    const session = store.getSession(event.sessionId) as { directory?: string } | null
    publishGoalSnapshot(
      event.sessionId,
      session ? session.directory ?? undefined : event.directory,
      event.payload.type === "goal-updated" ? event.payload.goal : null,
    )
  })

  /**
   * The single Goal mutation path. `stop` is deliberately ungated: it is the
   * safety valve that must end a running Goal even on a harness that offers no
   * pause/resume/delete, so it is not one of `GOAL_ACTIONS`.
   */
  const runGoalMutation = async (
    sessionId: string,
    mutation: GoalAction | "stop",
    requestedDirectory?: RuntimeDirectory,
  ): Promise<AgentGoalMutationResult> => {
    const context = await availableGoalContext(sessionId, requestedDirectory)
    if (mutation !== "stop") {
      try {
        requireGoalAction(context.capabilities, mutation)
      } catch (error) {
        const message = error instanceof GoalCapabilityError ? error.message : `Goal action '${mutation}' is unavailable`
        throw new AgentRuntimeGoalError("goal_action_unavailable", message)
      }
    }
    const result = await context.resource[mutation](sessionId, context.directory) as AgentGoalMutationResult
    publishGoalResult(sessionId, context.directory, result)
    return result
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
        const persistedConfig = store.updateSessionConfig(session.id, config)
        if (!persistedConfig) throw new Error(`Session ${session.id} has no runtime config`)
        const persistedSession = store.getSession(session.id)
        if (!persistedSession) throw new Error(`Session ${session.id} was not persisted`)
        return persistedSession as AgentSession
      },
      async get(sessionId: string, _directory?: RuntimeDirectory): Promise<AgentSession | null> {
        return store.getSession(sessionId) as AgentSession | null
      },
      async list(inputDirectory: RuntimeDirectory): Promise<AgentSession[]> {
        return store.listSessions(runtimeDirectory(inputDirectory)) as AgentSession[]
      },
      async update(sessionId: string, updates: { title?: string; time?: { archived?: number } }, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId)
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
        const adapter = await adapterForSession(sessionId)
        await adapter.deleteSession(sessionId, directory)
        store.deleteSession(sessionId)
        publishedGoalSignatures.delete(sessionId)
      },
    },
    turns: {
      async start(turn: AgentRuntimeTurnStartInput): Promise<AgentRuntimeTurnStartResult> {
        if ((turn.actorId === undefined) !== (turn.actorKind === undefined)) {
          throw new Error("Turn actor id and kind must be provided together")
        }
        const session = store.getSession(turn.sessionId) as { directory?: string } | null
        if (!session) throw new Error(`Session ${turn.sessionId} not found`)
        if (turn.admission && !turn.admission.valid()) {
          throw new Error("Durable session turn admission is no longer valid")
        }
        const { adapter, config } = await runtimeForSession(turn.sessionId)
        const directory = session.directory ?? undefined
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
          // The turn's author travels with the prompt as well as with the
          // durable turn record: a harness stamps it onto the user message it
          // builds itself, and without it every message a harness authors is
          // attributed to nobody.
          ...(turn.author ? { author: turn.author } : {}),
        }
        if (activeTurnAdmissions.has(turn.sessionId)) {
          throw new AgentRuntimeTurnAdmissionError(turn.sessionId)
        }
        const admission = {}
        activeTurnAdmissions.set(turn.sessionId, admission)
        // The store lease is the CROSS-INSTANCE admission: two runtimes sharing
        // one store (two route clients, say) must not both admit a turn for the
        // same session. The in-memory map above only covers this instance.
        const leaseId = store.acquireTurnLease(turn.sessionId)
        if (!leaseId) {
          activeTurnAdmissions.delete(turn.sessionId)
          throw new AgentRuntimeTurnAdmissionError(turn.sessionId)
        }
        activeTurnLeases.set(turn.sessionId, leaseId)
        const releaseAdmission = () => {
          if (activeTurnLeases.get(turn.sessionId) === leaseId) activeTurnLeases.delete(turn.sessionId)
          store.releaseTurnLease(turn.sessionId, leaseId)
          if (activeTurnAdmissions.get(turn.sessionId) === admission) {
            activeTurnAdmissions.delete(turn.sessionId)
          }
        }
        turn.onAdmitted?.()
        try {
          const agentSessionId = store.getAgentSessionId(turn.sessionId) ?? undefined
          const started = store.startTurn(turnStartRecord(turn, prompt, userMessageId, assistantMessageId, agentSessionId))
          for (const payload of started.events) {
            if (turn.admission && !turn.admission.valid()) break
            publish({ sessionId: turn.sessionId, directory, payload })
          }
          const openingUserPublished = started.events.some((payload) =>
            payload.type === "message.updated"
            && payload.properties.info.role === "user"
            && payload.properties.info.id === userMessageId)
          void runTurn(turn.sessionId, prompt, directory, adapter, admission, !!handoff, openingUserPublished, turn.admission)
            .finally(releaseAdmission)
        } catch (error) {
          releaseAdmission()
          throw error
        }
        return { sessionId: turn.sessionId, userMessageId, assistantMessageId, directory, prompt }
      },
      async abort(sessionId: string, directory?: RuntimeDirectory): Promise<AgentRuntimeAbortResult> {
        const adapter = await adapterForSession(sessionId)
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
          const lease = activeTurnLeases.get(sessionId)
          if (lease) {
            activeTurnLeases.delete(sessionId)
            store.releaseTurnLease(sessionId, lease)
          }
        }
        return result
      },
    },
    goals: {
      async capabilities(sessionId: string, directory?: RuntimeDirectory): Promise<GoalCapabilities> {
        return (await goalResourceContext(sessionId, directory)).capabilities
      },
      async read(sessionId: string, directory?: RuntimeDirectory): Promise<RuntimeGoalSnapshot | null> {
        const context = await goalResourceReadContext(sessionId, directory)
        return await context.resource.read(sessionId, context.directory)
      },
      async start(input: AgentRuntimeGoalStartInput, directory?: RuntimeDirectory): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>> {
        if (typeof input?.objective !== "string") {
          throw new AgentRuntimeGoalError("goal_invalid_objective", "Goal objective must be a string")
        }
        const objective = input.objective.trim()
        if (!objective || objective.length > 4_000) {
          throw new AgentRuntimeGoalError(
            "goal_invalid_objective",
            "Goal objective must contain between 1 and 4,000 characters",
          )
        }
        return await withGoalStartAdmission(input.sessionId, async () => {
          const context = await availableGoalContext(input.sessionId, directory)
          if (await context.resource.read(input.sessionId, context.directory)) {
            throw new AgentRuntimeGoalError("goal_already_exists", `Session ${input.sessionId} already has a Goal`)
          }
          const result = await context.resource.start(input.sessionId, { objective }, context.directory)
          publishGoalResult(input.sessionId, context.directory, result)
          return result
        })
      },
      async pause(sessionId: string, directory?: RuntimeDirectory) {
        return await runGoalMutation(sessionId, "pause", directory)
      },
      async resume(sessionId: string, directory?: RuntimeDirectory) {
        return await runGoalMutation(sessionId, "resume", directory)
      },
      async stop(sessionId: string, directory?: RuntimeDirectory): Promise<AgentGoalMutationResult> {
        return await runGoalMutation(sessionId, "stop", directory)
      },
      async delete(sessionId: string, directory?: RuntimeDirectory) {
        return await runGoalMutation(sessionId, "delete", directory) as AgentGoalMutationResult<null>
      },
    },
    events: {
      subscribe(subscribe: AgentRuntimeSubscribeInput = {}) {
        return createRuntimeSubscription(subscribers, subscribe, input.subscriberBufferSize ?? 256, input.eventDelivery)
      },
      async list(sessionId: string, directory?: RuntimeDirectory): Promise<AgentMessage[]> {
        const adapter = await adapterForSession(sessionId)
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
        const adapter = await interactionAdapter("respondPermission", permission?.sessionID)
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
        const adapter = await interactionAdapter("replyQuestion", question?.sessionID)
        if (!adapter?.replyQuestion) throw new Error("No registered harness supports questions")
        const result = await adapter.replyQuestion(questionId, answer, directory)
        publishInteractionEvents(result?.events, directory)
        return result
      },
      async reject(questionId: string, directory: RuntimeDirectory): Promise<AgentRuntimeInteractionResult | void> {
        const question = (await merge(adapters, (adapter) => adapter.listQuestions?.(directory)) as AgentQuestion[])
          .find((item) => item.id === questionId)
        const adapter = await interactionAdapter("rejectQuestion", question?.sessionID)
        if (!adapter?.rejectQuestion) throw new Error("No registered harness supports questions")
        const result = await adapter.rejectQuestion(questionId, directory)
        publishInteractionEvents(result?.events, directory)
        return result
      },
    },
    todos: {
      async list(sessionId: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId)
        if (!adapter.getTodos) throw new Error("This harness does not support todos")
        return await adapter.getTodos(sessionId, directory)
      },
    },
    commands: {
      async list(directory: RuntimeDirectory) {
        return merge(adapters, (adapter) => adapter.listCommands?.(directory))
      },
      async execute(sessionId: string, command: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId)
        if (!adapter.executeCommand) throw new Error("This harness does not support commands")
        return await adapter.executeCommand(sessionId, command, directory)
      },
    },
    config: {
      async read(sessionId: string, _directory?: RuntimeDirectory) {
        return await configForSession(sessionId)
      },
      async update(sessionId: string, update: SessionConfigUpdate, directory?: RuntimeDirectory) {
        return await updateSessionConfig(sessionId, update, directory)
      },
      async options(directory: RuntimeDirectory) {
        return merge(adapters, async (adapter) => (await adapter.probeConfigOptions?.(directory))?.options)
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
        const adapter = await adapterForSession(sessionId)
        return await adapter.readHarnessCapabilities(directory, { sessionId })
      },
    },
    dispose() {
      activeTurnAdmissions.clear()
      goalStartAdmissions.clear()
      publishedGoalSignatures.clear()
      unsubscribeGoalBridge()
      for (const subscriber of subscribers) subscriber.close()
      for (const adapter of adapters.values()) adapter.dispose()
      store.close?.()
    },
  }
}

function key(input: Pick<SessionHarness, "id" | "access">) {
  return `${input.id}:${input.access}`
}

async function merge<T>(adapters: Map<string, AgentHarnessAdapter>, read: (adapter: AgentHarnessAdapter) => Promise<T[] | undefined> | T[] | undefined) {
  const out: T[] = []
  for (const adapter of adapters.values()) {
    const rows = await read(adapter)
    if (rows) out.push(...rows)
  }
  return out
}
