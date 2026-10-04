import type { AgentConfigOption } from "@claxedo/agent-runtime-contract"

export function modelAndEffortOptions(input: {
  models: readonly { id: string; name: string; description?: string; connected?: boolean; resolvedModel?: string }[]
  selected?: string
  efforts?: readonly string[]
  currentEffort?: string
}): AgentConfigOption[] {
  if (!input.models.length) return []
  const options: AgentConfigOption[] = [{
    id: "model", name: "Model", category: "model", type: "select",
    ...(input.selected ? { currentValue: input.selected } : {}),
    selectOptions: input.models.map((model) => ({ ...model })),
  }]
  if ((input.efforts?.length ?? 0) > 1) options.push({
    id: "effort", name: "Effort", category: "thought_level", type: "select",
    ...(input.currentEffort ? { currentValue: input.currentEffort } : {}),
    selectOptions: input.efforts!.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })),
  })
  return options
}
