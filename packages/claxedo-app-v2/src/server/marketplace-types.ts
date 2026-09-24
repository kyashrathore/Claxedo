export type PluginHarness = "opencode" | "claude" | "codex" | "cursor"

export type PluginActivation = {
  readonly explicit?: boolean | null
  readonly projectOverride?: boolean | null
  readonly userDefault?: boolean | null
  readonly organizationDefault?: boolean
  readonly claxedoDefault?: boolean
  readonly effective: { readonly status: "ready" | "artifact-unavailable"; readonly effective: boolean; readonly winner: string }
}

export type PluginSource = {
  readonly id: string
  readonly kind: "claxedo" | "personal" | "organization"
  readonly label: string
  readonly repository?: string
}

export type PluginToolGroup = { readonly id: string; readonly pluginInstanceId: string; readonly enabled: boolean; readonly tools: readonly string[] }

export type PluginSkill = { readonly name: string; readonly description: string; readonly path: string }

export type PluginCandidate = {
  readonly pluginInstanceId: string
  readonly builtIn?: boolean
  readonly groups?: readonly PluginToolGroup[]
  readonly source: PluginSource | null
  readonly icon?: { readonly kind: "url"; readonly url: string } | { readonly kind: "monogram"; readonly text: string }
  readonly categories?: readonly string[]
  readonly featured?: boolean
  readonly skills: readonly PluginSkill[]
  readonly sourceAvailable: boolean
  readonly artifactAvailable?: boolean
  readonly artifactError?: string
  readonly updateAvailable: boolean
  readonly manifest: { readonly name: string; readonly version?: string; readonly description?: string } | null
  readonly harnesses: Readonly<Record<PluginHarness, PluginActivation>>
}

export type MarketplaceCatalogError = { readonly sourceId: string; readonly relativePath: string; readonly code: string; readonly message: string }

export type MarketplaceCatalog = {
  readonly revision: number
  readonly supportedHarnesses: readonly PluginHarness[]
  readonly projects?: readonly { readonly id: string; readonly label: string }[]
  readonly selectedProjectId?: string | null
  readonly candidates: readonly PluginCandidate[]
  readonly errors: readonly MarketplaceCatalogError[]
}

export type PluginActivationInput = {
  readonly pluginInstanceId: string
  readonly harnessIds: readonly PluginHarness[]
  readonly choice: boolean | null
  readonly revision: number
}

export type PluginChange = { readonly revision: number; readonly reconciliation: { readonly state: string; readonly message?: string } }

export type PluginSourceRecord = {
  readonly id: string
  readonly kind: PluginSource["kind"]
  readonly label: string
  readonly repository: string
  readonly ref: string
  readonly canRemove: boolean
}

export type PluginSourceInput = { readonly owner: string; readonly repository: string; readonly ref?: string }
