import type { AgentConfigOption } from "@claxedo/agent-runtime-contract"
import type { ConfigOptionsPreview } from "./transport"

export function configOptionsPreview(options: readonly AgentConfigOption[]): ConfigOptionsPreview {
  const model = options.find((option) => option.type === "select" && (option.category === "model" || option.id === "model"))
  const id = typeof model?.currentValue === "string" ? model.currentValue : undefined
  const name = id === undefined ? undefined : model?.selectOptions?.find((choice) => choice.id === id)?.name
  return id !== undefined && name ? { options, resolvedModel: { id, name } } : { options }
}
