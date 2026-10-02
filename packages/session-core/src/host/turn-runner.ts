import type { AgentExecutionBinding, AgentTurnOutcome, PromptInput } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeStreamEvent, RuntimeDirectory } from "./contracts"
import { createTurnBroker, type BrokerOwner, type TurnAuthority } from "@claxedo/harness/broker"
import { TransportError, type RoutedEvent, type TurnOrigin } from "@claxedo/harness/contract"
import { createChildEventRouter, type ChildProjectionTarget } from "../projection/child-event-routing"
import { resolveChildRoute, type BoundChildRoute } from "../projection/child-routes"
import { createTurnEventProjector } from "../projection/turn-projection"
import type { RuntimeAppendSource } from "../projection/session-event-writer"
import type { AttachedSession } from "./attachments"
import type { ParentTurnContext } from "./child-turns"
import type { AgentRuntimeEventEnvelope, AgentRuntimeStore, AgentRuntimeTurnStartInput } from "./contracts"
import { normalizeDirectory } from "./execution-binding"
import type { AdmittedTurnCapture, RuntimeRecovery, TurnFinalization } from "./recovery"
import type { createSessionTitleOwner } from "./session-titles"
import type { SteeredInputs } from "./steered-inputs"
import type { TurnAdmissions } from "./turn-admission"
import { turnInputFor } from "./turn-input"
import { isTerminalRuntimePayload, mergeOutcome, outcomeFromPayload, stoppedOutcome } from "./turn-outcome"
import { createTurnPublication } from "./turn-publication"

type Fence = AgentRuntimeTurnStartInput["admission"]

export type TurnRunnerHost = {
  store: AgentRuntimeStore
  admissions: TurnAdmissions
  recovery: RuntimeRecovery
  titles: ReturnType<typeof createSessionTitleOwner>
  broker: BrokerOwner
  steers: SteeredInputs
  ownerGeneration: string
  publish: (event: AgentRuntimeEventEnvelope) => void
  commit: (sessionId: string, directory: RuntimeDirectory, payload: AgentRuntimeStreamEvent, source: RuntimeAppendSource,
    fence: Fence, emit: (event: AgentRuntimeEventEnvelope) => void) => AgentRuntimeStreamEvent
  beginChildTurns: (parentSessionId: string, context: ParentTurnContext) => () => void
  childTarget: (childSessionId: string, assistantMessageId: string) => ChildProjectionTarget | undefined
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
  /** Applied once this turn's producer has ended; the session admits no other turn or harness switch until it settles. */
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
    takeSteeredInput: (messageId) => host.steers.take(run.capture.admission, messageId),
    onEvent: (payload) => publishTurn({ sessionId, directory, payload }),
    onRuntimeEvent,
  })
  const unseededTarget = (route: BoundChildRoute): ChildProjectionTarget => ({
    sessionId: route.childSessionId,
    getAgentSessionId: () => store.getAgentSessionId(route.childSessionId) ?? route.childSessionId,
    assistantMessageId: route.assistantMessageId,
    created: Date.now(),
    input: { agent: run.prompt.agent, model: run.prompt.model, ...(run.prompt.variant ? { variant: run.prompt.variant } : {}) },
  })
  const router = createChildEventRouter({
    parent,
    resolve: (correlationKey) => resolveChildRoute(store, sessionId, correlationKey),
    childTarget: (route) => host.childTarget(route.childSessionId, route.assistantMessageId) ?? unseededTarget(route),
    createChildProjector: (target) => createTurnEventProjector({
      store,
      owner: { sessionId: target.sessionId, getAgentSessionId: target.getAgentSessionId },
      directory,
      input: target.input,
      assistantMessageId: target.assistantMessageId,
      created: target.created,
      ...(target.fencingToken === undefined ? {} : { fencingToken: target.fencingToken }),
      onEvent: (payload) => publishTurn({ sessionId: target.sessionId, directory, payload }),
      onRuntimeEvent,
    }),
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
    projectChild: (target, event, source) => router.projectChild(target, event, source),
  })
  let finalized: TurnFinalization | undefined
  let outcome: AgentTurnOutcome | undefined
  let titled = false
  let settling: { release: () => void } | undefined
  try {
    let terminal = false
    const placeholder = titles.placeholder(sessionId, normalizeDirectory(directory), prompt)
    if (placeholder) host.commit(sessionId, directory, placeholder, { dir: "in", method: "auto-title" }, fence, publishTurn)
    const turn = turnInputFor(prompt, store.getTodos(sessionId), run.origin)
    try {
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
    } finally {
      if (run.afterTurn && admitted()) settling = admissions.gate(sessionId)
    }
    if (!admitted()) return
    if (!terminal && recovery.stops.sent(capture)) {
      finalized = recovery.cancelActiveTurn(capture)
      return
    }
    if (!terminal || !outcome) throw new TransportError("provider", "missing_terminal_event",
      "Harness stream ended without a terminal event", { detail: { code: "missing_terminal_event", transport: run.attached.handle.transport.kind } })
    const settled = stoppedOutcome(outcome, recovery.stops.sent(capture))
    finalized = recovery.finalizeTurn(capture, settled, { emit: publishTurn })
    recovery.retainFailure(capture, settled, finalized)
    if (finalized.ok && settled.status === "completed") {
      if (run.clearsHandoff) store.updateSessionConfig(sessionId, { handoff: null })
      titled = true
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
    settling?.release()
    if (titled) {
      void titles.generate({ sessionId, directory: normalizeDirectory(directory), transport: run.attached.handle.transport, session: run.attached.session })
    }
  }
}
