import type { AgentExecutionBinding, AgentTurnOutcome, PromptInput } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeStreamEvent, RuntimeDirectory } from "@claxedo/agent-sdk-runtime"
import { createTurnBroker, type BrokerOwner, type TurnAuthority } from "@claxedo/harness/broker"
import { TransportError, type RoutedEvent, type TurnOrigin } from "@claxedo/harness/contract"
import { createChildEventRouter } from "../projection/child-event-routing"
import { createTurnEventProjector, type RuntimeAppendSource } from "../projection/turn-projection"
import type { AttachedSession } from "./attachments"
import type { ParentTurnContext } from "./child-turns"
import type { AgentRuntimeEventEnvelope, AgentRuntimeStore, AgentRuntimeTurnStartInput } from "./contracts"
import { normalizeDirectory } from "./execution-binding"
import type { AdmittedTurnCapture, RuntimeRecovery, TurnFinalization } from "./recovery"
import type { createSessionTitleOwner } from "./session-titles"
import type { TurnAdmissions } from "./turn-admission"
import { turnInputFor } from "./turn-input"
import { isTerminalRuntimePayload, mergeOutcome, outcomeFromPayload } from "./turn-outcome"
import { createTurnPublication } from "./turn-publication"

type Fence = AgentRuntimeTurnStartInput["admission"]

export type TurnRunnerHost = {
  store: AgentRuntimeStore
  admissions: TurnAdmissions
  recovery: RuntimeRecovery
  titles: ReturnType<typeof createSessionTitleOwner>
  broker: BrokerOwner
  ownerGeneration: string
  publish: (event: AgentRuntimeEventEnvelope) => void
  commit: (sessionId: string, directory: RuntimeDirectory, payload: AgentRuntimeStreamEvent, source: RuntimeAppendSource,
    fence: Fence, emit: (event: AgentRuntimeEventEnvelope) => void) => AgentRuntimeStreamEvent
  beginChildTurns: (parentSessionId: string, context: ParentTurnContext) => () => void
}

export type TurnRun = {
  attached: AttachedSession
  binding: AgentExecutionBinding
  prompt: PromptInput
  origin: TurnOrigin
  capture: AdmittedTurnCapture
  releaseAdmission: () => void
  clearsHandoff: boolean
  fence: Fence
  /** Applied once this turn's producer has ended, before the next turn can start. */
  afterTurn?: () => Promise<void>
}

function appendSource(routed: RoutedEvent): RuntimeAppendSource {
  return routed.source ?? { dir: "in", method: "sendMessage" }
}

function projectors(host: TurnRunnerHost, run: TurnRun, publishTurn: (event: AgentRuntimeEventEnvelope) => void, admitted: () => boolean) {
  const { store } = host
  const sessionId = run.binding.sessionId
  const directory = normalizeDirectory(run.binding.directory)
  const fenced = run.fence ? { fencingToken: run.fence.fencingToken() } : {}
  const onRuntimeEvent = (event: AgentRuntimeEventEnvelope) => { if (admitted()) publishTurn(event) }
  const parent = createTurnEventProjector({
    store,
    owner: { sessionId, getAgentSessionId: () => store.getAgentSessionId(sessionId) ?? sessionId },
    directory,
    input: run.prompt,
    assistantMessageId: run.prompt.assistantMessageId,
    created: Date.now(),
    ...fenced,
    onEvent: (payload) => publishTurn({ sessionId, directory, payload }),
    onRuntimeEvent,
  })
  const router = createChildEventRouter({
    parent,
    createChildProjector: (target) => createTurnEventProjector({
      store,
      owner: { sessionId: target.sessionId, getAgentSessionId: target.getAgentSessionId },
      directory,
      input: target.input,
      assistantMessageId: target.assistantMessageId,
      created: target.created,
      ...fenced,
      onEvent: (payload) => publishTurn({ sessionId: target.sessionId, directory, payload }),
      onRuntimeEvent,
    }),
    onDiagnostic: (payload) => { if (admitted()) publishTurn({ sessionId, directory, payload }) },
  })
  return router
}

/**
 * One admitted turn from its first harness event to its finalization. Two
 * fences guard every producer write: the in-process admission generation and
 * the host's durable lease, which a takeover elsewhere can invalidate while
 * this instance still owns the in-memory slot.
 */
export async function runTurn(host: TurnRunnerHost, run: TurnRun): Promise<void> {
  const { store, admissions, recovery, titles } = host
  const { binding, prompt, capture, fence } = run
  const sessionId = binding.sessionId
  const directory = binding.directory
  const admitted = () => admissions.owns(sessionId, capture.admission) && (fence?.valid() ?? true)
  if (!admitted()) return
  const { publish: publishTurn, finish: finishPublication } = createTurnPublication(sessionId, host.publish, run.releaseAdmission)
  const router = projectors(host, run, publishTurn, admitted)
  const controller = new AbortController()
  const untrackStop = recovery.stops.track(capture, controller)
  const authority: TurnAuthority = { ...binding, ownerGeneration: host.ownerGeneration, turnId: prompt.assistantMessageId }
  const turnBroker = createTurnBroker(host.broker, { authority, origin: run.origin, signal: controller.signal })
  const endChildTurns = host.beginChildTurns(sessionId, {
    directory: normalizeDirectory(directory),
    input: prompt,
    ...(fence ? { fencingToken: fence.fencingToken() } : {}),
    associate: (key, target) => router.associate(key, target),
    projectChild: (target, event, source) => router.projectChild(target, event, source),
  })
  let finalized: TurnFinalization | undefined
  let outcome: AgentTurnOutcome | undefined
  try {
    let terminal = false
    const placeholder = titles.placeholder(sessionId, normalizeDirectory(directory), prompt)
    if (placeholder) host.commit(sessionId, directory, placeholder, { dir: "in", method: "auto-title" }, fence, publishTurn)
    const turn = turnInputFor(prompt, store.getTodos(sessionId), run.origin)
    for await (const routed of run.attached.handle.transport.send(run.attached.session, turn, turnBroker)) {
      if (!admitted()) return
      const payload: AgentRuntimeEvent = routed.event
      if (routed.route?.kind !== "child") {
        terminal ||= isTerminalRuntimePayload(payload)
        outcome = mergeOutcome(outcome, outcomeFromPayload(payload))
        if (outcome?.status === "failed" && isTerminalRuntimePayload(payload)) continue
      }
      router.project(payload, appendSource(routed), routed.route)
    }
    if (!admitted()) return
    if (!terminal && recovery.stops.sent(capture)) {
      finalized = recovery.cancelActiveTurn(capture)
      return
    }
    if (!terminal || !outcome) throw new TransportError("provider", "missing_terminal_event",
      "Harness stream ended without a terminal event", { detail: { code: "missing_terminal_event", transport: run.attached.handle.transport.kind } })
    const settled = outcome
    finalized = recovery.finalizeTurn(capture, settled, { emit: publishTurn })
    recovery.retainFailure(capture, settled, finalized)
    if (finalized.ok && outcome?.status === "completed") {
      if (run.clearsHandoff) store.updateSessionConfig(sessionId, { handoff: null })
      void titles.generate({ sessionId, directory: normalizeDirectory(directory), transport: run.attached.handle.transport, session: run.attached.session })
    }
  } catch (err) {
    if (!admitted()) return
    const failure = {
      status: "failed" as const,
      completedAt: Date.now(),
      error: err instanceof Error ? err.message : "turn failed",
      ...(err instanceof TransportError && err.detail ? { detail: err.detail } : {}),
    }
    if (recovery.stops.unconfirmed(capture)) {
      finalized = recovery.stops.hold(capture, failure, { handle: run.attached.handle, endChildren: () => {
        try { endChildTurns() } finally { router.dispose() }
      } })
      return
    }
    finalized = recovery.finalizeTurn(capture, failure, { emit: publishTurn })
    recovery.retainFailure(capture, failure, finalized)
  } finally {
    controller.abort()
    untrackStop()
    if (finalized?.ok || finalized?.reason !== "outcome_unknown") {
      try { endChildTurns() } catch (error) { recovery.reportSessionFailure(sessionId, error) }
      router.dispose()
    }
    try {
      await host.broker.endTurn(authority)
    } catch (error) {
      recovery.reportSessionFailure(sessionId, error)
    }
    if (run.afterTurn) {
      try { await run.afterTurn() } catch (error) { recovery.reportSessionFailure(sessionId, error) }
    }
    finishPublication((finalized ?? recovery.abandonTurn(capture, publishTurn)).ok)
  }
}
