export type ModelKey = { providerID: string; modelID: string; variant?: string }

type AgentModel = {
  providerID: string
  modelID: string
}

type Agent = {
  model?: AgentModel
  variant?: string
}

type Model = AgentModel & {
  variants?: Record<string, unknown>
}

type VariantInput = {
  variants: string[]
  selected: string | null | undefined
  configured: string | undefined
}

export type ProviderModel = { id: string; name?: string }
export type ProviderItem = {
  id: string
  models?: Record<string, ProviderModel>
}
export type ProviderModelInfo = ProviderModel & { provider: ProviderItem }
export type SubmitModelInfo = { id: string; name?: string; provider: { id: string } }

// Keep the familiar first-party providers near the top without granting any
// provider a fallback/default role. Unknown providers retain their input order.
const preferredProviderOrder = ["anthropic", "openai", "google"]

export function firstConnectedModel(input: {
  connected: ProviderItem[]
  defaults: Record<string, string | undefined>
}): ModelKey | undefined {
  const model = firstConnectedModelInfo(input)
  if (!model) return undefined
  return { providerID: model.provider.id, modelID: model.id }
}

export function firstConnectedModelInfo(input: {
  connected: ProviderItem[]
  defaults: Record<string, string | undefined>
}): ProviderModelInfo | undefined {
  return sortedConnectedProviders(input.connected)
    .map((provider) => {
      const configured = input.defaults[provider.id]
      const models = Object.values(provider.models ?? {})
      const model = configured && provider.models?.[configured]
        ? provider.models[configured]
        : models[0]
      if (!model) return undefined
      return { ...model, provider }
    })
    .find((model): model is ProviderModelInfo => !!model)
}

/** Explicit selection only — never substitute provider defaults or placeholders. */
export function selectRuntimeModel(_input: unknown, selected: SubmitModelInfo | undefined): SubmitModelInfo | undefined {
  return selected
}

/**
 * The provider whose full detail must load before a saved selection can be
 * validated — or `undefined` when nothing is missing.
 *
 * The boot catalog is an INDEX: every provider's id/name, but only the one
 * default model per connected provider. A saved selection of any OTHER model
 * of a connected provider is therefore indistinguishable from an invalid one
 * until that provider's detail (`GET /provider with ?provider=<id>`) merges in. This
 * names the exact miss: the provider is connected and present, yet the
 * selected model is absent from its model table.
 */
export function selectionProviderDetailNeeded(input: {
  model: ModelKey | undefined
  connected: ReadonlySet<string>
  provider: { models: Record<string, unknown> } | undefined
}): string | undefined {
  if (!input.model) return undefined
  if (!input.connected.has(input.model.providerID)) return undefined
  if (!input.provider) return undefined
  if (input.provider.models[input.model.modelID]) return undefined
  return input.model.providerID
}

export function firstValidSelectionModel(input: {
  selections: Array<{ model?: ModelKey } | undefined>
  valid: (model: ModelKey) => boolean
}) {
  for (const selection of input.selections) {
    const model = selection?.model
    if (!model) continue
    if (input.valid(model)) return model
  }
}

function sortedConnectedProviders(providers: ProviderItem[]) {
  return providers.slice().sort((left, right) =>
    providerRank(left.id) - providerRank(right.id)
  )
}

function providerRank(id: string) {
  const index = preferredProviderOrder.indexOf(id)
  return index === -1 ? preferredProviderOrder.length : index
}

export function getConfiguredAgentVariant(input: { agent: Agent | undefined; model: Model | undefined }) {
  if (!input.agent?.variant) return undefined
  if (!input.agent.model) return undefined
  if (!input.model?.variants) return undefined
  if (input.agent.model.providerID !== input.model.providerID) return undefined
  if (input.agent.model.modelID !== input.model.modelID) return undefined
  if (!(input.agent.variant in input.model.variants)) return undefined
  return input.agent.variant
}

export function resolveModelVariant(input: VariantInput) {
  if (input.selected === null) return undefined
  if (input.selected && input.variants.includes(input.selected)) return input.selected
  if (input.configured && input.variants.includes(input.configured)) return input.configured
  return undefined
}

export function cycleModelVariant(input: VariantInput) {
  if (input.variants.length === 0) return undefined
  if (input.selected === null) return input.variants[0]
  if (input.selected && input.variants.includes(input.selected)) {
    const index = input.variants.indexOf(input.selected)
    if (index === input.variants.length - 1) return undefined
    return input.variants[index + 1]
  }
  if (input.configured && input.variants.includes(input.configured)) {
    const index = input.variants.indexOf(input.configured)
    if (index === input.variants.length - 1) return input.variants[0]
    return input.variants[index + 1]
  }
  return input.variants[0]
}

export type PromptModelStateInput = {
  harnessMode: boolean
  providerLoading: boolean
  restoreLoading?: boolean
  model?: { id?: string; name?: string; provider?: { id: string } } | null
  agent?: { name?: string } | null
  agentOverride?: string
}

export function promptModelState(input: PromptModelStateInput) {
  if (input.harnessMode) {
    return {
      blocked: false,
      disabled: false,
      label: undefined as string | undefined,
    }
  }

  if (input.model) {
    return {
      blocked: false,
      disabled: false,
      label: input.model.name,
    }
  }

  if (input.providerLoading || input.restoreLoading) {
    return {
      blocked: true,
      disabled: true,
      label: "Loading models",
    }
  }

  return {
    blocked: true,
    disabled: true,
    label: "Select model",
  }
}

export type PromptModelFallbackInput = {
  harnessMode: boolean
  existingSession?: boolean
  hasCurrentModel: boolean
  hasSelection: boolean
  providerLoading: boolean
  restoreLoading?: boolean
  /** Provider detail for a saved selection is still merging into the index catalog. */
  selectionCatalogPending?: boolean
}

export type PromptModelResolutionState =
  | { type: "harness-owned" }
  | { type: "selected" }
  | { type: "invalid-selected" }
  | { type: "resolved" }
  | { type: "hydrating" }
  | { type: "needs-selection" }
  | { type: "uninitialized" }

export function promptModelResolutionState(input: PromptModelFallbackInput): PromptModelResolutionState {
  if (input.harnessMode) return { type: "harness-owned" }
  if (input.hasCurrentModel) return { type: "resolved" }
  if (input.hasSelection && (input.providerLoading || input.restoreLoading || input.selectionCatalogPending)) {
    return { type: "selected" }
  }
  if (input.providerLoading || input.restoreLoading || input.selectionCatalogPending) {
    return { type: "hydrating" }
  }
  if (input.hasSelection) return { type: "invalid-selected" }
  if (input.existingSession) return { type: "needs-selection" }
  return { type: "uninitialized" }
}

/** @deprecated Use {@link promptModelResolutionState}. Fallback models are never applied. */
export const promptModelFallbackState = promptModelResolutionState

/** @deprecated Composer model selection never falls back to catalog defaults. */
export function shouldUsePromptFallbackModel(_input: PromptModelFallbackInput) {
  return false
}
