import type { Agent } from "@opencode-ai/sdk/v2/client"

type ModelKey = { providerID: string; modelID: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

export function sameState(a?: State, b?: State) {
  return (a?.agent ?? "") === (b?.agent ?? "")
    && (a?.variant ?? null) === (b?.variant ?? null)
    && (a?.model?.providerID ?? "") === (b?.model?.providerID ?? "")
    && (a?.model?.modelID ?? "") === (b?.model?.modelID ?? "")
}

export function withCurrentAgent(list: Agent[], name?: string, state?: State) {
  if (!name) return list
  if (list.some((item) => item.name === name)) return list
  if (!state?.model && typeof state?.variant !== "string") return list
  return [
    {
      name,
      mode: "all",
      permission: [],
      options: {},
      ...(state?.model ? { model: state.model } : {}),
      ...(typeof state?.variant === "string" ? { variant: state.variant } : {}),
    } satisfies Agent,
    ...list,
  ]
}
