import type { AgentMessage, AgentSession, SavedCommand, SessionConfigUpdate, SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeStreamEvent, RuntimeDirectory } from "./contracts"
import type { ConnectionSecretAuthority } from "@claxedo/agent-runtime-contract"
import { createRequestBroker, type BrokerPorts } from "@claxedo/harness/broker"
import type { HarnessSession, HarnessTransport } from "@claxedo/harness/contract"
import { SessionAttachments, type AttachedSession } from "./attachments"
import { createChildTurns } from "./child-turns"
import { providerParentTurn } from "./provider-child-turns"
import { createHarnessReads } from "./config-ops"
import { AgentRuntimeTurnAdmissionError } from "./contracts"
import type {
  AgentRuntimeEventEnvelope,
  AgentRuntimeRecovery,
  AgentRuntimeSessionCreateInput,
  AgentRuntimeSubscribeInput,
  AgentRuntimeTurnStartInput,
  AgentRuntimeTurnStartResult,
  CreateAgentRuntimeInput,
} from "./contracts"
import { normalizeDirectory as runtimeDirectory, requireExecutionBinding } from "./execution-binding"
import { createRuntimeGoalController } from "./goal-controller"
import { announceContextRebuild, announceHandoff } from "./handoff"
import { createRuntimeLifecycle } from "./lifecycle"
import { createRuntimeRecovery } from "./recovery"
import { recoveryWiring } from "./recovery-wiring"
import { createRequestSurface } from "./requests"
import { createPermissionModeWrite, createSessionRowWrites } from "./session-row"
import { createSessionLifecycle } from "./sessions"
import { createSessionTitleOwner } from "./session-titles"
import { createRuntimeSubscription, type RuntimeSubscriber } from "./subscription"
import { admitTurnMessageIds, createTurnAdmissions, deliverToBusySession } from "./turn-admission"
import { turnInputFor } from "./turn-input"
import { turnPrompt, turnStartRecord } from "./turn-record"
import { runTurn, type TurnRunnerHost } from "./turn-runner"
import { createSteeredInputs } from "./steered-inputs"
import { eventSessionId, sessionIdle, toPresentationEvent } from "../projection/presentation-events"

export {
  AGENT_RUNTIME_MESSAGE_ID_CONFLICT_CODE,
  AGENT_RUNTIME_TURN_CONFLICT_CODE,
  AgentRuntimeGoalError,
  AgentRuntimeMessageIdConflictError,
  AgentRuntimeRequestRefusedError,
  AgentRuntimeTurnAdmissionError,
  isAgentRuntimeGoalError,
  isAgentRuntimeMessageIdConflictError,
  isAgentRuntimeRequestRefusedError,
  isAgentRuntimeTurnAdmissionError,
} from "./contracts"
export type * from "./contracts"
export type { AttachedSession } from "./attachments"
export type { HarnessTarget } from "./config-ops"
export type { LaunchComposer } from "./launch"
export type { HarnessHandle, TransportResolver } from "./transports"

export type AgentRuntime = ReturnType<typeof createAgentRuntime>

export type AgentRuntimeCompositionInput = CreateAgentRuntimeInput & {
  ports: BrokerPorts
  ownerGeneration: string
  /** Runs after a session's turn ends, before the next one can start: a held configuration lands here. */
  afterTurn?: (sessionId: string) => Promise<void>
  savedCommands: () => readonly SavedCommand[]
}

/** The caller owns input.store and closes it after this runtime is disposed. */
export function createAgentRuntime(input: AgentRuntimeCompositionInput) {
  const { store, eventHub } = input
  const subscribers = new Set<RuntimeSubscriber>()
  const wiring = recoveryWiring(() => recovery)
  const lifecycle = createRuntimeLifecycle({ onTeardownFailure: (error) => recovery.reportOwnerFailure(error) })
  const { resource, track } = lifecycle
  const admissions = createTurnAdmissions(store, input.onActiveTurnChange)
  const workspaceId = input.identity?.workspaceId ?? input.launch.workspaceId

  const publish = (event: AgentRuntimeEventEnvelope) => {
    const presentation = toPresentationEvent(event.payload)
    if (presentation) eventHub.publishGlobal({ directory: runtimeDirectory(event.directory), payload: presentation })
    for (const subscriber of subscribers) {
      if (subscriber.input.sessionId && subscriber.input.sessionId !== event.sessionId) continue
      if (subscriber.input.directory !== undefined && subscriber.input.directory !== event.directory) continue
      subscriber.push(event)
    }
  }

  const childTurns = createChildTurns({
    store,
    publish: (sessionId, payload) => publish({ sessionId, directory: store.getSession(sessionId)?.directory, payload }),
    retainLeasedTurnFailure: (sessionId, turn, error) => recovery.retainLeasedTurnFailure(sessionId, turn, error),
    idleParent: (parentSessionId) => providerParentTurn(store, parentSessionId, publish),
    childTurnSettled: (childSessionId, assistantMessageId) => {
      void broker.endChildTurn(childSessionId, assistantMessageId).catch((error: unknown) => recovery.reportSessionFailure(childSessionId, error))
    },
  })
  const broker = createRequestBroker(childTurns.ports({
    ...input.ports,
    admitProviderTurn: (sessionId, turn, run) => {
      if (lifecycle.closing) return Promise.resolve({ admitted: false, reason: "closed" })
      return track(async () => {
        const result = await input.ports.admitProviderTurn(sessionId, turn, async (ref, signal) => {
          const endChildTurns = childTurns.beginTurn(sessionId, providerParentTurn(store, sessionId, publish))
          try { await run(ref, signal) } finally {
            try { endChildTurns() } catch (error) { recovery.reportSessionFailure(sessionId, error) }
          }
        })
        if (result.admitted) {
          const current = input.ports.currentTurnAuthority(sessionId)
          const leaseId = current?.turnId === result.turn.turnId ? store.readTurnAuthority(sessionId)?.leaseId : undefined
          void track(() => result.settled, leaseId)
        }
        return result
      })
    },
  }))
  const executing = new Map<string, { generation: object; attached: AttachedSession; ended: Promise<void> }>()
  const writeRow = createSessionRowWrites({ store, eventHub })
  const writeMode = createPermissionModeWrite({ store, writeRow })
  const attachments = new SessionAttachments({ store, transports: input.transports, launch: input.launch, broker, workspaceId, writeMode,
    executing: (sessionId, generation) => {
      const current = executing.get(sessionId)
      return admissions.active(sessionId)?.generation === generation && current?.generation === generation ? current.attached : undefined
    },
  })

  const commitAndPublish: TurnRunnerHost["commit"] = (sessionId, directory, payload, source, fence, emit) => {
    if (fence && !fence.valid()) throw new Error("Durable session turn admission is no longer valid")
    const presentation = toPresentationEvent(payload)
    if (!presentation) {
      emit({ sessionId, directory, payload })
      return payload
    }
    const agentSessionId = store.getAgentSessionId(sessionId) ?? undefined
    const appended = store.appendEvent({
      sessionId,
      ...(agentSessionId ? { agentSessionId } : {}),
      payload: presentation,
      source,
      ...(fence ? { fencingToken: fence.fencingToken() } : {}),
    })
    emit({ sessionId, directory, payload: appended.payload })
    if (appended.messageUpdate) emit({ sessionId, directory, payload: appended.messageUpdate })
    return appended.payload
  }

  const titles = createSessionTitleOwner({ store, eventHub })

  const recovery = createRuntimeRecovery({
    store,
    admissions,
    producer: lifecycle.producer,
    providerTurn: (sessionId) => input.ports.currentTurnAuthority(sessionId)?.turnId,
    cancelTarget: async (sessionId) => {
      const attached = await attachments.for(sessionId, undefined, executing.get(sessionId)?.generation)
      return { transport: attached.handle.transport, session: attached.session }
    },
    publish,
    announceIdle: (sessionId, directory) => eventHub.publishGlobal({ directory: runtimeDirectory(directory), payload: sessionIdle(sessionId) }),
    ...(input.identity ? { identity: input.identity } : {}),
    ...(input.recovery?.budgets ? { budgets: input.recovery.budgets } : {}),
    ...(input.recovery?.now ? { now: input.recovery.now } : {}),
  })

  const unsubscribeRetire = input.transports.onRetire((handle) => recovery.stops.releaseRetired(handle))

  const goals = createRuntimeGoalController({
    store,
    attached: (sessionId) => attachments.for(sessionId),
    unattached: (sessionId) => attachments.withoutAttaching(sessionId),
    publish,
    subscribeRuntime: eventHub.subscribeRuntime,
    captureTurn: recovery.captureSessionTurn,
    cancelCapturedTurn: recovery.stopCapturedTurn,
  })

  const sessions = createSessionLifecycle({
    store, transports: input.transports, launch: input.launch, broker, attachments, admissions, workspaceId, publish,
    reportSessionFailure: recovery.reportSessionFailure,
    forgetGoal: (sessionId) => goals.forgetSession(sessionId),
    pushTitle: titles.push,
    writeRow,
    writeMode,
  })
  const reads = createHarnessReads({ store, transports: input.transports, launch: input.launch, attachments, savedCommands: input.savedCommands, writeMode })
  const requests = createRequestSurface({ store, broker })

  const steers = createSteeredInputs()
  const turnHost: TurnRunnerHost = {
    store, admissions, recovery, titles, broker, steers, ownerGeneration: input.ownerGeneration, publish,
    commit: commitAndPublish,
    beginChildTurns: (parentSessionId, context) => childTurns.beginTurn(parentSessionId, context),
    childTarget: (childSessionId, assistantMessageId) => childTurns.target(childSessionId, assistantMessageId),
  }

  const startTurn = async (turn: AgentRuntimeTurnStartInput): Promise<AgentRuntimeTurnStartResult> => {
    if ((turn.actorId === undefined) !== (turn.actorKind === undefined)) {
      throw new Error("Turn actor id and kind must be provided together")
    }
    const session = store.getSession(turn.sessionId)
    if (!session) throw new Error(`Session ${turn.sessionId} not found`)
    if (turn.admission && !turn.admission.valid()) throw new Error("Durable session turn admission is no longer valid")
    // Capture the target before attachment yields. A replacement turn must
    // never inherit an input addressed to the previous one.
    const controlTarget = turn.delivery ? admissions.active(turn.sessionId) : undefined
    if (!turn.delivery && admissions.active(turn.sessionId)) throw new AgentRuntimeTurnAdmissionError(turn.sessionId)
    const authority = turnSecretAuthority(turn)
    let attached = controlTarget
      ? await attachments.for(turn.sessionId, undefined, controlTarget.generation)
      : await attachments.admit(turn.sessionId, authority)
    // Pinned before the first yield: a lease rotation or a removed connection
    // must not dispose the transport between this read and the turn's launch.
    const unpin = attached.handle.pin()
    let launched = false
    try {
      if (!controlTarget && !admissions.active(turn.sessionId) && attached.handle.transport.restore) {
        attached = { ...attached, session: await attached.handle.transport.restore(attached.session) }
      }
      const declared = await attached.handle.transport.capabilities({ directory: attached.session.directory, sessionId: turn.sessionId })
      if (lifecycle.closing) throw new Error("AgentRuntime is disposed")
      if (turn.admission && !turn.admission.valid()) throw new Error("Durable session turn admission is no longer valid")
      // Read after attaching: an attach that replaced a lost native session
      // persisted the handoff this turn has to carry.
      const config = store.getSessionConfig(turn.sessionId)
      if (!config) throw new Error(`Session ${turn.sessionId} has no runtime config`)
      const directory = session.directory ?? undefined
      const binding = requireExecutionBinding(store, turn.sessionId, directory)
      const { userMessageId, assistantMessageId } = admitTurnMessageIds(store, turn)
      const handoff = config.handoff?.pending ? config.handoff.transcript : undefined
      const prompt = turnPrompt({ turn, config, userMessageId, assistantMessageId, channel: declared.instructionChannel })
      const running = admissions.active(turn.sessionId)
      if (turn.delivery === "steer" && (!controlTarget || running?.generation !== controlTarget.generation)) {
        return { sessionId: turn.sessionId, userMessageId, assistantMessageId, directory, prompt,
          delivery: "queue", steering: { ok: false, status: "no_active_turn", message: "The target turn ended before steering" } }
      }
      if (controlTarget && running?.generation !== controlTarget.generation) return startTurn(turn)
      if (running) {
        if (!turn.delivery) throw new AgentRuntimeTurnAdmissionError(turn.sessionId)
        const live = await attachments.for(turn.sessionId, undefined, running.generation)
        const steer = live.handle.transport.steer
        const target = executing.get(turn.sessionId)
        const delivered = await deliverToBusySession({
          running, turn, prompt, userMessageId, assistantMessageId, directory,
          requested: turn.delivery,
          ...(target?.generation === running.generation ? { ended: target.ended } : {}),
          ...(steer ? { steer: () => {
            steers.expect(running.generation, { ...prompt, userMessageId })
            return steer.steer(live.session,
              { turnId: running.assistantMessageId, assistantMessageId: running.assistantMessageId },
              turnInputFor(prompt, store.getTodos(turn.sessionId), turn.origin))
          } } : {}),
        })
        if (delivered.steering && !delivered.steering.ok && delivered.steering.status !== "unknown") steers.forget(running.generation, userMessageId)
        return delivered.delivery === "steer" ? { ...delivered, target: recovery.turnTarget(turn.sessionId, running) } : delivered
      }
      if (turn.delivery === "queue" && store.getSession(turn.sessionId)?.time?.archived !== undefined) {
        throw new AgentRuntimeTurnAdmissionError(turn.sessionId, "Session is archived; its queued input stays queued")
      }
      const claimed = admissions.claim(turn.sessionId, {
        turnId: userMessageId,
        assistantMessageId,
        ...(turn.admission ? { fence: turn.admission } : {}),
      })
      if (!claimed) throw new AgentRuntimeTurnAdmissionError(turn.sessionId)
      const capture = recovery.captureTurn(turn.sessionId, claimed, directory)
      const releaseAdmission = claimed.release
      try {
        if (turn.permissionMode && turn.permissionMode !== config.permissionMode) {
          const kept = await reads.keepPermissionMode(attached, turn.permissionMode)
          if (kept.currentModeId !== turn.permissionMode) {
            throw new Error(`${attached.handle.runner.id} kept permission mode ${kept.currentModeId ?? "unknown"} instead of ${turn.permissionMode}`)
          }
        }
        turn.onAdmitted?.()
        const agentSessionId = store.getAgentSessionId(turn.sessionId) ?? undefined
        const started = store.startTurn(turnStartRecord(turn, prompt, userMessageId, assistantMessageId, agentSessionId))
        for (const payload of started.events) {
          if (turn.admission && !turn.admission.valid()) break
          publish({ sessionId: turn.sessionId, directory, payload })
        }
        announceContextRebuild({
          sessionId: turn.sessionId, assistantMessageId, config, binding, store,
          commit: (event) => commitAndPublish(turn.sessionId, directory, event, { dir: "out", method: "session.context-recovery" }, turn.admission, publish),
        })
        announceHandoff({
          sessionId: turn.sessionId, userMessageId, directory, config, store,
          closeSource: (harness, source, dir) => sessions.closeSource(harness, source, turn.sessionId, dir, authority),
          commit: (event) => commitAndPublish(turn.sessionId, directory, event, { dir: "out", method: "session/handoff" }, turn.admission, publish),
          diagnose: (payload) => publish({ sessionId: turn.sessionId, directory, payload }),
        })
        launched = true
        const ended = track(() => runTurn(turnHost, {
          attached, binding, prompt, origin: turn.origin, capture, releaseAdmission,
          clearsHandoff: !!handoff, fence: turn.admission,
          ...(input.afterTurn ? { afterTurn: () => input.afterTurn!(turn.sessionId) } : {}),
        }), capture.leaseId).catch((error: unknown) => recovery.reportTurnFailure(capture, error)).finally(() => {
          if (executing.get(turn.sessionId)?.generation === claimed.generation) executing.delete(turn.sessionId)
          unpin()
        })
        executing.set(turn.sessionId, { generation: claimed.generation, attached, ended })
      } catch (error) {
        releaseAdmission()
        throw error
      }
      return { sessionId: turn.sessionId, userMessageId, assistantMessageId, directory, prompt, delivery: "start", target: capture.target }
    } finally {
      if (!launched) unpin()
    }
  }

  return {
    attachments,
    abortStarts: sessions.abortStarts,
    reads,
    sessions: resource({
      create: (create: AgentRuntimeSessionCreateInput): Promise<AgentSession> => sessions.create(create),
      async get(sessionId: string, _directory?: RuntimeDirectory): Promise<AgentSession | null> {
        return store.getSession(sessionId) ?? null
      },
      async list(inputDirectory: RuntimeDirectory): Promise<AgentSession[]> {
        return store.listSessions(runtimeDirectory(inputDirectory))
      },
      update: (sessionId: string, updates: { title?: string; time?: { archived?: number } }, directory?: RuntimeDirectory,
        secretAuthority?: ConnectionSecretAuthority) => sessions.update(sessionId, updates, directory, secretAuthority),
      updateConfig: (sessionId: string, update: SessionConfigUpdate, directory?: RuntimeDirectory, secretAuthority?: ConnectionSecretAuthority) =>
        sessions.updateSessionConfig(sessionId, update, directory, secretAuthority),
      delete: (sessionId: string, directory?: RuntimeDirectory, secretAuthority?: ConnectionSecretAuthority) =>
        sessions.delete(sessionId, directory, secretAuthority),
      fork: (sessionId: string, messageId: string, childId?: string, directory?: RuntimeDirectory, secretAuthority?: ConnectionSecretAuthority) =>
        sessions.fork(sessionId, messageId, childId, directory, secretAuthority),
    }),
    turns: {
      whenIdle(sessionId: string) {
        return admissions.whenIdle(sessionId)
      },
      ...resource({ start: startTurn }),
    },
    goals: resource(goals.resource),
    recovery: wiring.surface() satisfies AgentRuntimeRecovery,
    events: {
      subscribe(subscribe: AgentRuntimeSubscribeInput = {}) {
        if (lifecycle.closing) throw new Error("AgentRuntime is disposed")
        return createRuntimeSubscription(subscribers, subscribe, input.subscriberBufferSize ?? 256)
      },
      ...resource({
        async list(sessionId: string, directory?: RuntimeDirectory): Promise<AgentMessage[]> {
          requireExecutionBinding(store, sessionId, directory)
          return store.getMessages(sessionId)
        },
      }),
    },
    permissions: resource(requests.permissions),
    questions: resource(requests.questions),
    subagents: {
      /** Admits and publishes an observation the host makes about its own child session. */
      admit: (parentSessionId: string, observation: SubagentObservation) => broker.subagents.admit(parentSessionId, observation),
    },
    health: {
      read(directory: string) {
        if (lifecycle.closing) throw new Error("AgentRuntime is disposed")
        return reads.health(directory)
      },
    },
    /** The transport and its harness session for one attached session, for the operations only a transport answers. */
    async transportFor(sessionId: string, directory?: string): Promise<{ transport: HarnessTransport; session: HarnessSession }> {
      const attached = await attachments.for(sessionId, directory, admissions.active(sessionId)?.generation)
      return { transport: attached.handle.transport, session: attached.session }
    },
    dispose() {
      return lifecycle.dispose(
        async () => {
          recovery.stops.releaseAll()
          for (const attached of attachments.entries()) broker.broker.closeSession(attached.session.binding.sessionId)
        },
        () => {
          unsubscribeRetire()
          admissions.clear()
          goals.dispose()
          for (const subscriber of subscribers) subscriber.close()
        },
      )
    },
  }
}

function turnSecretAuthority(turn: AgentRuntimeTurnStartInput): ConnectionSecretAuthority | undefined {
  return turn.admission ? { kind: "turn", lease: turn.admission.proof() } : undefined
}

export function streamEventSessionId(payload: AgentRuntimeStreamEvent): string | undefined {
  const presentation = toPresentationEvent(payload)
  return presentation ? eventSessionId(presentation) : undefined
}
