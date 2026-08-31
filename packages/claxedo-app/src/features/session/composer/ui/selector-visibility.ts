// The runtime-reported agent profile list is the capability signal. A runtime
// that does not support profiles returns no profiles, so no vendor identity is
// needed to decide whether the selector exists.
export function shouldShowPromptAgentSelector(input: { agentCount: number }) {
  return input.agentCount > 0
}
