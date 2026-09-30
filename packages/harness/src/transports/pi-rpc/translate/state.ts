import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic } from "@claxedo/agent-runtime-contract"

export type PiTranslatorState = {
  blocks: Record<number, string>
  finished: boolean
  failure?: string
  stopped: boolean
  noted: string[]
}

export type PiStep = { state: PiTranslatorState; events: AgentRuntimeEvent[] }

export const initialPiState = (): PiTranslatorState => ({ blocks: {}, finished: false, stopped: false, noted: [] })

export const step = (state: PiTranslatorState, events: AgentRuntimeEvent[] = []): PiStep => ({ state, events })

export function ignoredKind(state: PiTranslatorState, kind: string): PiStep {
  if (state.noted.includes(kind)) return step(state)
  return step({ ...state, noted: [...state.noted, kind] }, [{ type: "diagnostic", diagnostic: runtimeDiagnostic({
    code: "pi_rpc.ignored_frame", severity: "debug", source: "pi.rpc",
    message: `Pi record ${kind} is not known to this transport and is ignored`, details: { kind } }) }])
}
