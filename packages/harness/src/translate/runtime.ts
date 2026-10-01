import { normalizeDiagnostics, runtimeDiagnostic } from "@claxedo/agent-runtime-contract"
import { agentRuntimeEvent, type AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { Clock, CreateId } from "@claxedo/agent-runtime-contract"
import { createSequentialIdFactory, systemClock } from "@claxedo/agent-runtime-contract"
import type { RawHarnessEvent } from "@claxedo/agent-runtime-contract"
import { rawHarnessEvent } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapter, HarnessEventAdapterContext, HarnessEventAdapterResult } from "./adapter"
import { frameExcerpt } from "./frame-excerpt"

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

const DIAGNOSTIC_SURFACE_TYPES: ReadonlySet<AgentRuntimeEvent["type"]> = new Set([
  "auth-status",
  "diagnostic",
  "harness-notice",
  "mcp-server-status",
  "rate-limit",
])

export type AgentEventRuntime<State = unknown> = {
  ingest: (event: RawHarnessEvent) => TranslateRawHarnessEventResult<State>
}

function withRuntimeMeta(event: AgentRuntimeEvent, context: HarnessEventAdapterContext, frame: RawHarnessEvent): AgentRuntimeEvent {
  const located = { harness: context.harness, threadId: context.threadId, ...event }
  if (!DIAGNOSTIC_SURFACE_TYPES.has(event.type)) return located
  if (located.type !== "diagnostic") return { ...located, raw: frame }
  const { raw: _raw, ...diagnostic } = located.diagnostic
  return { ...located, diagnostic, raw: frame }
}

function adapterEvents<State>(input: TranslateRawHarnessEventInput<State>) {
  const translated = input.adapter.translate({ state: input.state, event: rawHarnessEvent(input.event), context: input.context })
  const result = Array.isArray(translated) ? { events: translated } : translated satisfies HarnessEventAdapterResult<State>
  const diagnostics = normalizeDiagnostics(result.diagnostics).map((diagnostic) => agentRuntimeEvent.diagnostic({ diagnostic }))
  return { state: result.state ?? input.state, events: [...(result.events ?? []), ...diagnostics] }
}

function adapterFailure(event: RawHarnessEvent, error: unknown): AgentRuntimeEvent {
  return agentRuntimeEvent.diagnostic({
    diagnostic: runtimeDiagnostic({
      code: "runtime.adapter_error",
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
      source: event.source,
      method: event.method,
    }),
  })
}

export function translateRawHarnessEvent<State>(
  input: TranslateRawHarnessEventInput<State>,
): TranslateRawHarnessEventResult<State> {
  const { source, method, payload } = input.event
  const frame = { source, ...(method ? { method } : {}), payload: frameExcerpt(payload) }
  const located = (events: AgentRuntimeEvent[]) => events.map((event) => withRuntimeMeta(event, input.context, frame))
  try {
    const result = adapterEvents(input)
    return { state: result.state, events: located(result.events) }
  } catch (error) {
    return { state: input.state, events: located([adapterFailure(input.event, error)]) }
  }
}

export function createAgentEventRuntime<State>(options: {
  harness: string
  threadId: string
  adapter: HarnessEventAdapter<State>
  clock?: Clock
  createId?: CreateId
}): AgentEventRuntime<State> {
  if (!options.harness) throw new Error("createAgentEventRuntime requires harness")
  if (!options.threadId) throw new Error("createAgentEventRuntime requires threadId")
  const initial = options.adapter.createInitialState?.()
  if (initial === undefined) throw new Error(`Adapter ${options.adapter.name} did not provide initial state`)
  let state: State = initial
  const now = options.clock ?? systemClock
  const createId = options.createId ?? createSequentialIdFactory()
  const context = { harness: options.harness, threadId: options.threadId, now, createId }

  return {
    ingest(event) {
      const result = translateRawHarnessEvent({
        adapter: options.adapter,
        state,
        event,
        context,
      })
      state = result.state
      return result
    },
  }
}
