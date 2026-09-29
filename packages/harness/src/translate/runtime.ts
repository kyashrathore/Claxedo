import { normalizeDiagnostics, runtimeDiagnostic } from "@claxedo/agent-runtime-contract"
import { agentRuntimeEvent, type AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { Clock, CreateId } from "@claxedo/agent-runtime-contract"
import { createSequentialIdFactory, systemClock } from "@claxedo/agent-runtime-contract"
import type { RawHarnessEvent } from "@claxedo/agent-runtime-contract"
import { rawHarnessEvent } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapter, HarnessEventAdapterContext, HarnessEventAdapterResult } from "./adapter"

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
        ...(DIAGNOSTIC_SURFACE_TYPES.has(event.type) ? { raw: input.event } : {}),
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
