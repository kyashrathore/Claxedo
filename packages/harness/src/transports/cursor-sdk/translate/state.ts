import type { AgentRuntimeEvent, RuntimeTokenUsage } from "@claxedo/agent-runtime-contract"

export type CursorToolRecord = { toolName: string; kind: string; input?: Record<string, unknown> }

export type CursorSdkAdapterState = {
  toolsByCallId: Record<string, CursorToolRecord>
  usageByRunId: Record<string, RuntimeTokenUsage>
  openShells: string[]
  shellOutputByCallId: Record<string, string>
  notedKinds: string[]
}

export type CursorTranslation = { state: CursorSdkAdapterState; events: AgentRuntimeEvent[] }

export function createCursorSdkAdapterState(): CursorSdkAdapterState {
  return { toolsByCallId: {}, usageByRunId: {}, openShells: [], shellOutputByCallId: {}, notedKinds: [] }
}

export function endedRunState(state: CursorSdkAdapterState): CursorSdkAdapterState {
  return { ...createCursorSdkAdapterState(), notedKinds: state.notedKinds }
}

export function unchanged(state: CursorSdkAdapterState, events: AgentRuntimeEvent[] = []): CursorTranslation {
  return { state, events }
}
