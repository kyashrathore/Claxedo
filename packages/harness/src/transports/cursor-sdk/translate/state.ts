export type CursorSdkAdapterState = {
  assistantTextByRunId: Record<string, string>
  thinkingTextByRunId: Record<string, string>
  toolsByCallId: Record<string, {
    toolName: string
    kind: string
    input?: Record<string, unknown>
  }>
}

export function createCursorSdkAdapterState(): CursorSdkAdapterState {
  return { assistantTextByRunId: {}, thinkingTextByRunId: {}, toolsByCallId: {} }
}

export function pruneTurnState() {
  return createCursorSdkAdapterState()
}
