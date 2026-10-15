export function userMessageHead(input: { readonly agent?: string; readonly harnessLabel?: string; readonly model: string }): string {
  const agent = input.agent
  const who = agent ? agent[0]?.toUpperCase() + agent.slice(1) : input.harnessLabel ?? ""
  return [who, input.model].filter((item) => !!item).join(" · ")
}
