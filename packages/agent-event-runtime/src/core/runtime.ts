import { normalizeDiagnostics, runtimeDiagnostic } from "../contracts/diagnostics"
import { agentRuntimeEvent, type AgentRuntimeEvent } from "../contracts/agent-runtime-event"
import type { Clock, CreateId } from "../contracts/ids"
import { createSequentialIdFactory, systemClock } from "../contracts/ids"
import type { RawHarnessEvent } from "../contracts/raw-harness-event"
import { rawHarnessEvent } from "../contracts/raw-harness-event"
import type { HarnessEventAdapter, HarnessEventAdapterContext, HarnessEventAdapterResult } from "./adapter"
import type { RuntimeSnapshot } from "./state"
import { assertRuntimeSnapshot, cloneSnapshotValue, runtimeSnapshot } from "./state"

export type TranslateRawHarnessEventInput<State = unknown> = {
  adapter: HarnessEventAdapter<State>
  state: State
  event: RawHarnessEvent
  context: HarnessEventAdapterContext
}

export type TranslateRawHarnessEventResult<State = unknown> = {
  state: State
  events: AgentRuntimeEvent[]
}

export type AgentEventRuntime<State = unknown> = {
  ingest: (event: RawHarnessEvent) => TranslateRawHarnessEventResult<State> & { snapshot: RuntimeSnapshot<State> }
  snapshot: () => RuntimeSnapshot<State>
}

export function translateRawHarnessEvent<State>(
  input: TranslateRawHarnessEventInput<State>,
): TranslateRawHarnessEventResult<State> {
  try {
    const translated = input.adapter.translate({
      state: input.state,
      event: rawHarnessEvent(input.event),
      context: input.context,
    })
    const result = Array.isArray(translated)
      ? { events: translated }
      : translated satisfies HarnessEventAdapterResult<State>
    const diagnostics = normalizeDiagnostics(result.diagnostics)
    const diagnosticEvents = diagnostics.map((diagnostic): AgentRuntimeEvent => agentRuntimeEvent.diagnostic({
      diagnostic,
      harness: input.context.harness,
      threadId: input.context.threadId,
      raw: input.event,
    }))
    return {
      state: result.state ?? input.state,
      events: [...(result.events ?? []), ...diagnosticEvents].map((event) => ({
        harness: input.context.harness,
        threadId: input.context.threadId,
        raw: input.event,
        ...event,
      })),
    }
  } catch (error) {
    const diagnostic = runtimeDiagnostic({
      code: "runtime.adapter_error",
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
      source: input.event.source,
      method: input.event.method,
      raw: input.event.payload,
    })
    return {
      state: input.state,
      events: [agentRuntimeEvent.diagnostic({
        diagnostic,
        harness: input.context.harness,
        threadId: input.context.threadId,
        raw: input.event,
      })],
    }
  }
}

export function createAgentEventRuntime<State>(options: {
  harness: string
  threadId: string
  adapter: HarnessEventAdapter<State>
  clock?: Clock
  createId?: CreateId
  initialSnapshot?: RuntimeSnapshot<State>
}): AgentEventRuntime<State> {
  if (!options.harness) throw new Error("createAgentEventRuntime requires harness")
  if (!options.threadId) throw new Error("createAgentEventRuntime requires threadId")
  const initial = options.initialSnapshot ? assertRuntimeSnapshot(options.initialSnapshot) : undefined
  if (initial && (initial.harness !== options.harness || initial.threadId !== options.threadId)) {
    throw new Error("RuntimeSnapshot does not match harness/threadId")
  }
  const stateFromSnapshot = initial?.adapterState === undefined ? undefined : cloneSnapshotValue(initial.adapterState)
  const stateFromAdapter = stateFromSnapshot === undefined ? options.adapter.createInitialState?.() : stateFromSnapshot
  if (stateFromAdapter === undefined) throw new Error(`Adapter ${options.adapter.name} did not provide initial state`)
  let state: State = stateFromAdapter
  const now = options.clock ?? systemClock
  const createId = options.createId ?? createSequentialIdFactory()
  const context = { harness: options.harness, threadId: options.threadId, now, createId }

  const snapshot = () => runtimeSnapshot({
    harness: options.harness,
    threadId: options.threadId,
    adapterState: state,
  })

  return {
    ingest(event) {
      const result = translateRawHarnessEvent({
        adapter: options.adapter,
        state,
        event,
        context,
      })
      state = result.state
      return { ...result, snapshot: snapshot() }
    },
    snapshot,
  }
}
