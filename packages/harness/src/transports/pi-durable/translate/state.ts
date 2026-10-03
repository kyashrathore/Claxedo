import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic } from "@claxedo/agent-runtime-contract"

export type PiUsageTotals = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

export type PiDurableTranslatorState = {
  blocks: Record<number, string>
  usage: PiUsageTotals
  noted: string[]
}

export type PiStep = { state: PiDurableTranslatorState; events: AgentRuntimeEvent[] }

export const EMPTY_USAGE: PiUsageTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

export const initialPiDurableState = (): PiDurableTranslatorState => ({ blocks: {}, usage: EMPTY_USAGE, noted: [] })

export const piStep = (state: PiDurableTranslatorState, events: AgentRuntimeEvent[] = []): PiStep => ({ state, events })

export function ignoredKind(state: PiDurableTranslatorState, kind: string): PiStep {
  if (state.noted.includes(kind)) return piStep(state)
  return piStep({ ...state, noted: [...state.noted, kind] }, [{ type: "diagnostic", diagnostic: runtimeDiagnostic({
    code: "pi.unrecognized_event", severity: "debug", source: "pi.durable",
    message: `Pi event ${kind} is not known to this transport and is ignored`, details: { kind } }) }])
}
