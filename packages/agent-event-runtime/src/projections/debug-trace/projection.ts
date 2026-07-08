import type { AgentRuntimeEvent } from "../../contracts/agent-runtime-event"
import type { RuntimeProjection } from "../../core/projection"
import { projectionSnapshot, type ProjectionSnapshot } from "../../core/state"

export type DebugTraceEvent = {
  runtimeType: string
  harness?: string
  threadId?: string
  raw?: unknown
  diagnostics?: unknown
}

export type DebugTraceProjectionState = {
  count: number
}

export type DebugTraceProjection = RuntimeProjection<DebugTraceEvent, DebugTraceProjectionState> & {
  name: "debug-trace"
}

export function createDebugTraceProjection(options?: {
  initialSnapshot?: ProjectionSnapshot<DebugTraceProjectionState>
}): DebugTraceProjection {
  const state = { count: options?.initialSnapshot?.state.count ?? 0 }
  return {
    name: "debug-trace",
    ingest(event) {
      state.count += 1
      return [{
        runtimeType: event.type,
        harness: event.harness,
        threadId: event.threadId,
        raw: event.raw,
        diagnostics: event.type === "diagnostic" ? event.diagnostic : event.diagnostics,
      }]
    },
    snapshot() {
      return projectionSnapshot("debug-trace", state)
    },
  } satisfies DebugTraceProjection
}
