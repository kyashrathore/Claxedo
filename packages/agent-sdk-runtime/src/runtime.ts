import { randomUUID } from "crypto"
import {
  AgentRuntimeContractError,
  connectionIdForHarness,
  type AgentExecutionBinding,
} from "@claxedo/agent-runtime-contract"
import { assistantMessageIdForTurn, type AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type {
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentRuntimeStreamEvent,
  AgentSession,
  HarnessCapabilities,
  PromptInput,
  RuntimeDirectory,
  SessionConfig,
  SessionConfigUpdate,
  SessionHarness,
  AgentTurnOutcome,
} from "./index"
import type { AgentHarnessAdapter } from "./adapter-contract"
import { hasAdapterCapability } from "./capabilities"
import { admitSessionInstructions } from "./session-instructions"
import { eventSessionId, sessionIdle, toCompatEvent, type CompatEvent } from "./compat-events"
import { createTurnEventProjector } from "./harnesses/shared/turn-projection"
import { createChildEventRouter } from "./harnesses/shared/child-event-routing"
import { createRuntimeEventHub } from "./runtime-event-hub"
import { DEFAULT_MODEL_ID } from "./session-model"
import { createRuntimeSubscription, type RuntimeSubscriber } from "./runtime/subscription"
import { isTerminalRuntimePayload, mergeOutcome, outcomeFromPayload } from "./runtime/turn-outcome"
import { createTurnPublication } from "./runtime/turn-publication"
import { turnPrompt, turnStartRecord } from "./runtime/turn-record"
import { assertSessionCreateBindingScope, normalizeDirectory as runtimeDirectory, requireExecutionBinding } from "./runtime/execution-binding"
import { executeHandoffTransaction } from "./runtime/handoff-transaction"
import { createRuntimeLifecycle } from "./runtime/lifecycle"
import { createRuntimeGoalController } from "./runtime/goal-controller"
import { createSessionTitleOwner } from "./runtime/session-titles"
import { createTurnAdmissions, deliverToBusySession } from "./runtime/turn-admission"

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
  AgentRuntimeEventEnvelope,
  AgentRuntimeGoalErrorCode,
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
import { AgentRuntimeTurnAdmissionError } from "./runtime/contracts"
import type {
  AgentHarnessFactory,
  AgentRuntimeAbortResult,
  AgentRuntimeEventEnvelope,
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

export type AgentRuntime = ReturnType<typeof createAgentRuntime>

function isProjectableRuntimeEvent(payload: AgentRuntimeStreamEvent): payload is AgentRuntimeEvent {
  return !toCompatEvent(payload) && payload.type !== "server.heartbeat"
}

/** The caller owns input.store and closes it after every sharing runtime is disposed. */
export function createAgentRuntime(input: CreateAgentRuntimeInput) {
  const eventHub = input.eventHub ?? createRuntimeEventHub()
  const store = input.store
  const adapters = new Map(input.harnesses.map((factory) => [
    key(factory),
    factory.create({ store, eventHub }),
  ]))
  const resolvingAdapters = new Map<string, Promise<AgentHarnessAdapter>>()
  const subscribers = new Set<RuntimeSubscriber>()
  const lifecycle = createRuntimeLifecycle()
  const { resource, track } = lifecycle
  // The session is claimed before the user/assistant rows are persisted, so a
  // refused concurrent prompt cannot manufacture a failed turn or overwrite the
  // status of the turn that is actually running.
  const admissions = createTurnAdmissions(store)

  const adapterFor = async (harness: SessionHarness) => {
    const harnessKey = key(harness)
    const existing = adapters.get(harnessKey)
    if (existing) return existing
    if (!input.resolveHarness) throw new Error(`No harness registered for ${harness.id}:${harness.access}`)
    const pending = resolvingAdapters.get(harnessKey)
    if (pending) return await pending
    const resolution = Promise.resolve()
      .then(() => input.resolveHarness!(harness))
      .then(async (resolved) => {
        if (lifecycle.closing) {
          if (input.adapterOwnership !== "caller") await resolved.dispose()
          throw new Error("AgentRuntime is disposed")
        }
        adapters.set(harnessKey, resolved)
        return resolved
      })
      .finally(() => resolvingAdapters.delete(harnessKey))
    resolvingAdapters.set(harnessKey, resolution)
    return await resolution
  }

  const runtimeForSession = async (
    sessionId: string,
  ): Promise<{ adapter: AgentHarnessAdapter; config: SessionConfig }> => {
    const stored = store.getSessionConfig(sessionId)
    if (!stored) throw new Error(`Session ${sessionId} has no runtime config`)
    return { adapter: await adapterFor(stored.harness), config: stored }
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

  const executionBinding = (
    sessionId: string,
    directory?: RuntimeDirectory,
    expectedHarness?: SessionHarness,
  ): AgentExecutionBinding => requireExecutionBinding(store, sessionId, directory, expectedHarness)

  const assertCreateBindingScope = (sessionId: string, create: AgentRuntimeSessionCreateInput) =>
    assertSessionCreateBindingScope(store, sessionId, create)

  const presentationSession = (session: AgentSession | null): AgentSession | null => {
    if (!session) return null
    if (!store.getSessionConfig(session.id)) {
      return { ...session, executionAvailability: { status: "selection-required", selection: "harness" } }
    }
    try {
      executionBinding(session.id, session.directory)
      return { ...session, executionAvailability: { status: "available" } }
    } catch (error) {
      return {
        ...session,
        executionAvailability: {
          status: "unavailable",
          message: error instanceof Error ? error.message : "Execution binding is unavailable",
        },
      }
    }
  }

  const publish = (event: AgentRuntimeEventEnvelope) => {
    const compat = toCompatEvent(event.payload)
    if (compat) eventHub.publishGlobal({ directory: runtimeDirectory(event.directory), payload: compat })
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
    emit: typeof publish = publish,
  ) => {
    if (fence && !fence.valid()) throw new Error("Durable session turn admission is no longer valid")
    const compat = toCompatEvent(payload)
    if (!compat) {
      emit({ sessionId, directory, payload })
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
    emit({ sessionId, directory, payload: committed })
    return committed
  }

  const titles = createSessionTitleOwner({ store, eventHub })

  const runTurn = async (
    binding: AgentExecutionBinding,
    prompt: PromptInput,
    adapter: AgentHarnessAdapter,
    admission: object,
    releaseAdmission: () => void,
    clearsHandoff = false,
    openingUserPublished = false,
    fence?: AgentRuntimeTurnStartInput["admission"],
  ) => {
    const sessionId = binding.sessionId
    const directory = binding.directory
    const ownsAdmission = () => admissions.owns(sessionId, admission)
    // Two fences guard every producer write for this turn. `ownsAdmission`
    // rejects a superseded in-process generation; `fence` is the host's
    // durable admission, which a takeover elsewhere can invalidate while this
    // instance still owns the in-memory slot.
    const admitted = () => ownsAdmission() && (fence?.valid() ?? true)
    if (!admitted()) return
    const { publish: publishTurn, finish: finishPublication } = createTurnPublication(sessionId, publish, admitted, releaseAdmission)
    // The store already published the opening user message with the turn
    // record; the adapter's own echo of it would fan a duplicate to every
    // subscriber, so exactly one echo is dropped.
    let openingUserAlreadyPublished = openingUserPublished
    let outcome: AgentTurnOutcome | undefined
    const stableAssistantMessageId = prompt.assistantMessageId
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
      onEvent: (payload) => publishTurn({ sessionId, directory, payload }),
      onRuntimeEvent: (event) => {
        if (!admitted()) return
        publishTurn({
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
        onEvent: (payload) => publishTurn({ sessionId: target.sessionId, directory, payload }),
        onRuntimeEvent: (event) => {
          if (!admitted()) return
          publishTurn({
            sessionId: event.sessionId,
            directory: event.directory,
            payload: event.payload,
          })
        },
      }),
      onDiagnostic: (payload) => {
        if (admitted()) publishTurn({ sessionId, directory, payload })
      },
    })
    try {
      if (!adapter.executeTurn) {
        throw new AgentRuntimeContractError({
          code: "unsupported_operation",
          operation: "executeTurn",
          message: `Harness ${binding.connectionId} does not support bound execution`,
        })
      }
      let terminal = false
      const placeholder = titles.placeholder(sessionId, runtimeDirectory(directory), prompt)
      if (placeholder) commitAndPublish(sessionId, directory, placeholder, { dir: "in", method: "auto-title" }, fence, publishTurn)
      for await (const payload of adapter.executeTurn(
        binding,
        prompt,
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
            if (adapter.commitsStreamEvents) {
            publishTurn({ sessionId, directory, payload: normalizeCompatEvent(compat) })
          } else {
            commitAndPublish(sessionId, directory, normalizeCompatEvent(compat), { dir: "in", method: "sendMessage" }, fence, publishTurn)
          }
          continue
        }
        if (isProjectableRuntimeEvent(payload)) {
          router.project(payload, { dir: "in", method: "sendMessage" })
          continue
        }
        publishTurn({ sessionId, directory, payload })
      }
      if (!admitted()) return
      if (!terminal) {
        const payload = sessionIdle(sessionId)
        outcome = mergeOutcome(outcome, outcomeFromPayload(payload))
        commitAndPublish(sessionId, directory, payload, { dir: "out", method: "runtime.finish" }, fence, publishTurn)
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
      for (const payload of finished.events) publishTurn({ sessionId, directory, payload })
      if (outcome?.status === "completed") {
        if (clearsHandoff) store.updateSessionConfig(sessionId, { handoff: null })
        void titles.generate(binding, runtimeDirectory(directory), adapter)
      }
    } catch (err) {
      if (!admitted()) return
      const message = err instanceof Error ? err.message : "turn failed"
      const finished = store.finishTurn({
        sessionId,
        assistantMessageId: prompt.assistantMessageId,
        outcome: { status: "failed", completedAt: Date.now(), error: message },
        ...(fence ? { fencingToken: fence.fencingToken() } : {}),
      })
      for (const payload of finished.events) publishTurn({ sessionId, directory, payload })
    } finally {
      router.dispose()
      finishPublication()
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
      const binding = executionBinding(sessionId, directory)
      const configured = adapter.sessionConfigOwner === "runtime"
        ? { ...current!, ...update }
        : await adapter.updateSessionConfig(binding, update)
      const persisted = store.updateSessionConfig(sessionId, configured)
      if (!persisted) throw new Error(`Session ${sessionId} has no runtime config`)
      return persisted
    }
    const session = store.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (session.status === "busy") throw new Error("Wait for the current turn to finish before switching harness")
    const targetDirectory = directory ?? session.directory
    const previousBinding = executionBinding(sessionId, targetDirectory, current.harness)
    const source = await adapterFor(current.harness)
    const target = await adapterFor(update.harness!)
    return executeHandoffTransaction({
      sessionId,
      directory: targetDirectory,
      session,
      current: current,
      update: { ...update, harness: update.harness! },
      binding: previousBinding,
      store,
      source,
      target,
      commit: (event) => {
        commitAndPublish(sessionId, targetDirectory, event, { dir: "out", method: "session/handoff" })
      },
      diagnose: (payload) => publish({ sessionId, directory: targetDirectory, payload }),
    })
  }

  const completeCancellation = (sessionId: string, directory?: RuntimeDirectory) => {
    store.finishTurn({
      sessionId,
      outcome: { status: "cancelled", completedAt: Date.now(), reason: "abort" },
    })
    // The runtime owns cancellation completion. Some adapters terminate
    // their stream after acknowledging abort, while a stuck adapter may
    // never yield again. Publish the canonical terminal frame before
    // releasing admission so route-level subscribers always settle and
    // any later adapter frames remain fenced as the old generation.
    eventHub.publishGlobal({ directory: runtimeDirectory(directory), payload: sessionIdle(sessionId) })
    publish({ sessionId, directory, payload: { type: "finish", sessionId } })
    admissions.discard(sessionId)
  }

  const goals = createRuntimeGoalController({
    store,
    adapterForSession,
    publish,
    subscribeRuntime: eventHub.subscribeRuntime,
    completeCancellation,
  })

  return {
    sessions: resource({
      async create(create: AgentRuntimeSessionCreateInput): Promise<AgentSession> {
        if (typeof create.workspaceId !== "string" || create.workspaceId.trim() === "") {
          throw new AgentRuntimeContractError({
            code: "invalid_execution_binding",
            field: "workspaceId",
            message: "execution binding workspaceId is required",
          })
        }
        if (typeof create.directory !== "string" || !create.directory.trim()) {
          throw new AgentRuntimeContractError({ code: "invalid_execution_binding", field: "directory", message: "execution binding directory is required" })
        }
        if (create.id) assertCreateBindingScope(create.id, create)
        const adapter = await adapterFor(create.harness)
        if (create.model && hasAdapterCapability(adapter, "runtime-config")) {
          adapter.setModel(create.model.modelID === DEFAULT_MODEL_ID ? "" : create.model.modelID)
        }
        const refusal = admitSessionInstructions({
          harness: create.harness.id,
          channel: adapter.instructionChannel,
          instructions: create.instructions,
        })
        if (refusal?.reason === "no_instruction_channel") {
          throw new AgentRuntimeContractError({ code: "unsupported_operation", operation: "session_instructions", message: refusal.message })
        }
        if (refusal) throw new Error(refusal.message)
        const retained = {
          ...(create.instructions ? { instructions: create.instructions } : {}),
          ...(create.group ? { group: create.group } : {}),
        }
        const session = await adapter.createSession(create.directory, create.title, create.id, retained)
        // Provider creation establishes the local row; the runtime completes
        // its workspace binding below. An unexpected returned id that already
        // has a complete binding belongs to another execution scope.
        if (session.id !== create.id && store.getExecutionBinding(session.id)) {
          assertCreateBindingScope(session.id, create)
        }
        const upstreamSessionId = session.agentSessionId ?? store.getAgentSessionId(session.id) ?? session.id
        store.bindSession({
          sessionId: session.id,
          workspaceId: create.workspaceId,
          directory: runtimeDirectory(create.directory),
          connectionId: connectionIdForHarness(create.harness),
          upstreamSessionId,
          title: create.title,
          agentSessionId: upstreamSessionId,
        })
        const model = create.model ?? store.getSessionConfig(session.id)?.model
        const config: SessionConfig = {
          harness: create.harness,
          ...(model ? { model } : {}),
          variant: create.variant ?? null,
          agent: create.agent ?? null,
          ...retained,
        }
        const persistedConfig = store.updateSessionConfig(session.id, config)
        if (!persistedConfig) throw new Error(`Session ${session.id} has no runtime config`)
        const persistedSession = store.getSession(session.id)
        if (!persistedSession) throw new Error(`Session ${session.id} was not persisted`)
        return persistedSession
      },
      async get(sessionId: string, _directory?: RuntimeDirectory): Promise<AgentSession | null> {
        return store.getSession(sessionId) ?? null
      },
      async list(inputDirectory: RuntimeDirectory): Promise<AgentSession[]> {
        return store.listSessions(runtimeDirectory(inputDirectory))
          .map((session) => presentationSession(session)!)
      },
      async update(sessionId: string, updates: { title?: string; time?: { archived?: number } }, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId)
        const updated = await adapter.updateSession(executionBinding(sessionId, directory), updates)
        if (!updated) throw new Error(`Session ${sessionId} not found`)
        const persisted = store.updateSession(sessionId, {
          ...(updated.title !== undefined ? { title: updated.title ?? undefined } : {}),
          ...(updated.time?.archived !== undefined ? { time: { archived: updated.time.archived } } : {}),
        })
        if (!persisted) throw new Error(`Session ${sessionId} not found`)
        return persisted
      },
      async updateConfig(sessionId: string, update: SessionConfigUpdate, directory?: RuntimeDirectory) {
        return await updateSessionConfig(sessionId, update, directory)
      },
      async delete(sessionId: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId)
        await adapter.deleteSession(executionBinding(sessionId, directory))
        store.deleteSession(sessionId)
        goals.forgetSession(sessionId)
      },
    }),
    turns: resource({
      async start(turn: AgentRuntimeTurnStartInput): Promise<AgentRuntimeTurnStartResult> {
        if ((turn.actorId === undefined) !== (turn.actorKind === undefined)) {
          throw new Error("Turn actor id and kind must be provided together")
        }
        const session = store.getSession(turn.sessionId)
        if (!session) throw new Error(`Session ${turn.sessionId} not found`)
        if (turn.admission && !turn.admission.valid()) {
          throw new Error("Durable session turn admission is no longer valid")
        }
        // Capture the target before adapter resolution yields. A replacement
        // turn must never inherit an input addressed to the previous one.
        const steeringTarget = turn.delivery === "steer" ? admissions.active(turn.sessionId) : undefined
        const { adapter, config } = await runtimeForSession(turn.sessionId)
        if (lifecycle.closing) throw new Error("AgentRuntime is disposed")
        if (turn.admission && !turn.admission.valid()) {
          throw new Error("Durable session turn admission is no longer valid")
        }
        const directory = session.directory ?? undefined
        const binding = executionBinding(turn.sessionId, directory)
        const userMessageId = turn.messageId ?? `msg_${randomUUID()}`
        const assistantMessageId = turn.assistantMessageId ?? assistantMessageIdForTurn(userMessageId)
        const handoff = config?.handoff?.pending ? config.handoff.transcript : undefined
        const prompt = turnPrompt({ turn, config, userMessageId, assistantMessageId, channel: adapter.instructionChannel })
        const running = admissions.active(turn.sessionId)
        if (turn.delivery === "steer" && (!steeringTarget || running?.generation !== steeringTarget.generation)) {
          return { sessionId: turn.sessionId, userMessageId, assistantMessageId, directory, prompt,
            delivery: "queue", steering: { ok: false, status: "no_active_turn", message: "The target turn ended before steering" } }
        }
        if (running) {
          if (!turn.delivery) throw new AgentRuntimeTurnAdmissionError(turn.sessionId)
          return await deliverToBusySession({
            running, turn, prompt, userMessageId, assistantMessageId, directory,
            requested: turn.delivery,
            ...(adapter.steerTurn ? { steer: () => adapter.steerTurn!(binding, prompt) } : {}),
          })
        }
        const claimed = admissions.claim(turn.sessionId, { turnId: userMessageId, assistantMessageId })
        if (!claimed) throw new AgentRuntimeTurnAdmissionError(turn.sessionId)
        const admission = claimed.generation
        const releaseAdmission = claimed.release
        try {
          turn.onAdmitted?.()
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
          void track(() => runTurn(binding, prompt, adapter, admission, releaseAdmission, !!handoff, openingUserPublished, turn.admission)
            .finally(releaseAdmission)).catch((error) => console.error("AgentRuntime turn finalization failed", error))
        } catch (error) {
          releaseAdmission()
          throw error
        }
        return { sessionId: turn.sessionId, userMessageId, assistantMessageId, directory, prompt, delivery: "start" }
      },
      async abort(sessionId: string, directory?: RuntimeDirectory, scope?: { turnId?: string }): Promise<AgentRuntimeAbortResult> {
        // A late abort names the turn the caller was looking at. Once a
        // different turn owns the session, stopping it is not what was asked.
        const running = admissions.active(sessionId)
        if (scope?.turnId && running && running.turnId !== scope.turnId) {
          return { ok: true, status: "already_idle" }
        }
        const adapter = await adapterForSession(sessionId)
        if (!adapter.abort) throw new Error("This harness does not support abort")
        const result = await adapter.abort(executionBinding(sessionId, directory))
        // An adapter with no live turn can still have an unfinished persisted
        // turn after its process restarted. Its idle acknowledgement also
        // completes that cancellation; otherwise Stop can never clear busy.
        if (result.ok && (result.status === "cancelled" || store.getSession(sessionId)?.status === "busy")) {
          completeCancellation(sessionId, directory)
        }
        return result
      },
      /** Resolves once the caller owns this session's next turn; a start that then fails must `abandon` it. */
      whenIdle(sessionId: string) {
        return admissions.whenIdle(sessionId)
      },
    }),
    goals: resource(goals.resource),
    events: {
      subscribe(subscribe: AgentRuntimeSubscribeInput = {}) {
        if (lifecycle.closing) throw new Error("AgentRuntime is disposed")
        return createRuntimeSubscription(subscribers, subscribe, input.subscriberBufferSize ?? 256)
      },
      ...resource({
      async list(sessionId: string, directory?: RuntimeDirectory): Promise<AgentMessage[]> {
        await adapterForSession(sessionId)
        executionBinding(sessionId, directory)
        return store.getMessages(sessionId)
      },
      }),
    },
    permissions: resource({
      async list(directory: RuntimeDirectory): Promise<AgentPermission[]> {
        return merge(adapters, (adapter) => adapter.listPermissions?.(directory))
      },
      async respond(permissionId: string, decision: AgentRuntimePermissionDecision, directory: RuntimeDirectory, optionId?: string): Promise<AgentRuntimeInteractionResult | void> {
        const permission = (await merge(adapters, (adapter) => adapter.listPermissions?.(directory)))
          .find((item) => item.id === permissionId)
        if (!permission) throw new Error(`Permission ${permissionId} not found`)
        const adapter = await interactionAdapter("respondPermission", permission?.sessionID)
        if (!adapter?.respondPermission) throw new Error("No registered harness supports permissions")
        const result = await adapter.respondPermission(executionBinding(permission.sessionID, directory), permissionId, decision, optionId)
        publishInteractionEvents(result?.events, directory)
        return result
      },
    }),
    questions: resource({
      async list(directory: RuntimeDirectory): Promise<AgentQuestion[]> {
        return merge(adapters, (adapter) => adapter.listQuestions?.(directory))
      },
      async answer(questionId: string, answers: AgentQuestionAnswer[], directory: RuntimeDirectory): Promise<AgentRuntimeInteractionResult | void> {
        const question = (await merge(adapters, (adapter) => adapter.listQuestions?.(directory)))
          .find((item) => item.id === questionId)
        if (!question) throw new Error(`Question ${questionId} not found`)
        const adapter = await interactionAdapter("replyQuestion", question?.sessionID)
        if (!adapter?.replyQuestion) throw new Error("No registered harness supports questions")
        const result = await adapter.replyQuestion(executionBinding(question.sessionID, directory), questionId, answers)
        publishInteractionEvents(result?.events, directory)
        return result
      },
      async reject(questionId: string, directory: RuntimeDirectory): Promise<AgentRuntimeInteractionResult | void> {
        const question = (await merge(adapters, (adapter) => adapter.listQuestions?.(directory)))
          .find((item) => item.id === questionId)
        if (!question) throw new Error(`Question ${questionId} not found`)
        const adapter = await interactionAdapter("rejectQuestion", question?.sessionID)
        if (!adapter?.rejectQuestion) throw new Error("No registered harness supports questions")
        const result = await adapter.rejectQuestion(executionBinding(question.sessionID, directory), questionId)
        publishInteractionEvents(result?.events, directory)
        return result
      },
    }),
    todos: resource({
      async list(sessionId: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId)
        if (!adapter.getTodos) throw new Error("This harness does not support todos")
        return await adapter.getTodos(executionBinding(sessionId, directory))
      },
    }),
    commands: resource({
      async list(directory: RuntimeDirectory) {
        return merge(adapters, (adapter) => adapter.listCommands?.(directory))
      },
      async execute(sessionId: string, command: string, directory?: RuntimeDirectory) {
        const adapter = await adapterForSession(sessionId)
        if (!adapter.executeCommand) throw new Error("This harness does not support commands")
        return await adapter.executeCommand(executionBinding(sessionId, directory), command)
      },
    }),
    config: resource({
      async read(sessionId: string, _directory?: RuntimeDirectory) {
        return await configForSession(sessionId)
      },
      async update(sessionId: string, update: SessionConfigUpdate, directory?: RuntimeDirectory) {
        return await updateSessionConfig(sessionId, update, directory)
      },
      async options(directory: RuntimeDirectory) {
        return merge(adapters, async (adapter) => (await adapter.probeConfigOptions?.(directory))?.options)
      },
    }),
    health: {
      read(directory: RuntimeDirectory): AgentRuntimeHealth[] {
        if (lifecycle.closing) throw new Error("AgentRuntime is disposed")
        return [...adapters.values()]
          .map((adapter) => adapter.readRuntimeHealth?.(directory))
          .filter((item): item is AgentRuntimeHealth => !!item)
      },
    },
    capabilities: resource({
      async read(sessionId: string, directory?: RuntimeDirectory): Promise<HarnessCapabilities> {
        const adapter = await adapterForSession(sessionId)
        return await adapter.readHarnessCapabilities(directory, { sessionId })
      },
    }),
    dispose() {
      return lifecycle.dispose(
        () => Promise.all(input.adapterOwnership === "caller"
          ? []
          : [...new Set(adapters.values())].map((adapter) => Promise.resolve().then(() => adapter.dispose()))),
        () => {
          admissions.clear()
          goals.dispose()
          for (const subscriber of subscribers) subscriber.close()
        },
      )
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
