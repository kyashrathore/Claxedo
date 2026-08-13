import {
  isSignedWorkspaceDefaultModel,
  SIGNED_WORKSPACE_DEFAULT_MODEL_ID,
  SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER,
} from "./signed-workspace-model"

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

type RuntimeModelProvider = {
  id: string
  models?: Record<string, ProviderModel>
}

// `opencode` is the zero-key gateway: it reports itself connected on every
// machine, so ranking it first made it the silent default even for a user who
// had just connected their own Anthropic/OpenAI key — and its free models fail
// upstream, so the very first turn errored. A provider the user actually
// authenticated outranks the gateway; the gateway stays last as the fallback
// for a machine with no credential at all, and its models remain pickable.
const preferredProviderOrder = ["anthropic", "openai", "google"]
const GATEWAY_PROVIDER = "opencode"
// The hosted default model is a placeholder the server may still list as a
// provider default before real models load; skip it so a signed-workspace user
// is never stuck on the placeholder once concrete models exist. Sourced from the
// single SIGNED_WORKSPACE_DEFAULT_MODEL definition so both call sites stay in sync.
const staleProviderDefaults: Record<string, Set<string>> = {
  [SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER]: new Set([SIGNED_WORKSPACE_DEFAULT_MODEL_ID]),
}

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
      const models = Object.values(provider.models ?? {}).filter((model) => !isSignedWorkspaceDefaultModel({
        id: model.id,
        provider: { id: provider.id },
      }))
      const model = configured && !staleProviderDefaults[provider.id]?.has(configured) && provider.models?.[configured]
        ? provider.models[configured]
        : models[0]
      if (!model) return undefined
      return { ...model, provider }
    })
    .find((model): model is ProviderModelInfo => !!model)
}

export function selectRuntimeModel(input: unknown, selected: SubmitModelInfo | undefined): SubmitModelInfo | undefined {
  if (selected && !isSignedWorkspaceDefaultModel(selected)) return selected
  const body = object(input)
  const all = runtimeProviders(body?.all)
  const connected = connectedProviderIds(body?.connected)
  const connectedRows = all.filter((provider) => connected.has(provider.id))
  return firstConnectedModelInfo({
    connected: connectedRows,
    defaults: stringDefaults(body?.default),
  })
}

/**
 * The provider whose full detail must load before a saved selection can be
 * validated — or `undefined` when nothing is missing.
 *
 * The boot catalog is an INDEX: every provider's id/name, but only the one
 * default model per connected provider. A saved selection of any OTHER model
 * of a connected provider is therefore indistinguishable from an invalid one
 * until that provider's detail (`/provider?provider=<id>`) merges in. This
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
  // The gateway sorts strictly after every other connected provider, including
  // ones absent from the preference list — those still imply a real credential.
  if (id === GATEWAY_PROVIDER) return preferredProviderOrder.length + 1
  const index = preferredProviderOrder.indexOf(id)
  return index === -1 ? preferredProviderOrder.length : index
}

function object(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function stringDefaults(input: unknown) {
  const row = object(input)
  if (!row) return {}
  return Object.fromEntries(
    Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function connectedProviderIds(input: unknown) {
  if (!Array.isArray(input)) return new Set<string>()
  return new Set(input.filter((item): item is string => typeof item === "string"))
}

function runtimeProviders(input: unknown): RuntimeModelProvider[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    const row = object(item)
    if (typeof row?.id !== "string") return []
    const models = object(row.models)
    return [
      {
        id: row.id,
        ...(models
          ? {
              models: Object.fromEntries(
                Object.entries(models).flatMap(([key, value]) => {
                  const model = object(value)
                  const id = typeof model?.id === "string" ? model.id : key
                  return [
                    [
                      key,
                      {
                        id,
                        ...(typeof model?.name === "string" ? { name: model.name } : {}),
                      },
                    ],
                  ]
                }),
              ),
            }
          : {}),
      },
    ]
  })
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

  if (input.model && !isSignedWorkspaceDefaultModel(
    input.model.id && input.model.provider ? { id: input.model.id, provider: input.model.provider } : undefined,
  )) {
    return {
      blocked: false,
      disabled: false,
      label: input.model.name,
    }
  }

  if (input.providerLoading) {
    return {
      blocked: true,
      disabled: true,
      label: "Loading models",
    }
  }

  return {
    blocked: true,
    disabled: true,
    label: input.model ? "Connect AI" : "Select model",
  }
}

export type PromptModelFallbackInput = {
  harnessMode: boolean
  existingSession?: boolean
  hasCurrentModel: boolean
  hasSelection: boolean
  providerLoading: boolean
  restoreLoading?: boolean
}

export type PromptModelFallbackState =
  | { type: "harness-owned"; fallback: false }
  | { type: "selected"; fallback: false }
  | { type: "invalid-selected"; fallback: true }
  | { type: "resolved"; fallback: false }
  | { type: "hydrating"; fallback: false }
  | { type: "needs-selection"; fallback: false }
  | { type: "uninitialized"; fallback: true }

export function promptModelFallbackState(input: PromptModelFallbackInput): PromptModelFallbackState {
  if (input.harnessMode) return { type: "harness-owned", fallback: false }
  if (input.hasCurrentModel) return { type: "resolved", fallback: false }
  if (input.hasSelection && (input.providerLoading || input.restoreLoading)) return { type: "selected", fallback: false }
  if (input.providerLoading || input.restoreLoading) return { type: "hydrating", fallback: false }
  if (input.hasSelection) return { type: "invalid-selected", fallback: true }
  if (input.existingSession) return { type: "needs-selection", fallback: false }
  return { type: "uninitialized", fallback: true }
}

export function shouldUsePromptFallbackModel(input: PromptModelFallbackInput) {
  return promptModelFallbackState(input).fallback
}
