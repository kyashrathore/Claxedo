export function shouldShowPromptAgentSelector(input: { isHarnessMode: boolean; agentCount: number }) {
  return !input.isHarnessMode && input.agentCount > 0
}
