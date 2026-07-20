// The agent (build/plan) picker only makes sense for OpenCode — other harnesses
// (codex, claude, cursor, …) have no agent concept, so upstream hides it for them.
// Gate on the resolved harness type POSITIVELY: a negative `!isHarnessMode` check
// leaks the picker during stale/pending harness resolution, showing it for a
// harness that doesn't support it.
export function shouldShowPromptAgentSelector(input: { isOpenCodeHarness: boolean; agentCount: number }) {
  return input.isOpenCodeHarness && input.agentCount > 0
}
