export type PluginHarness = "opencode" | "claude" | "codex" | "cursor" | "pi" | "acp"

export type PluginActivation = {
  readonly explicit?: boolean | null
  readonly projectOverride?: boolean | null
  readonly userDefault?: boolean | null
  readonly organizationDefault?: boolean
  readonly claxedoDefault?: boolean
  readonly effective: {
    readonly status: "ready" | "artifact-unavailable"
    readonly effective: boolean
    readonly winner: string
    readonly artifactDigest?: string | null
  }
}

export type PluginSourceKind = "claxedo" | "personal" | "organization"

export type PluginSource = {
  readonly id: string
  readonly kind: PluginSourceKind
  readonly label: string
  readonly repository?: string | null
}

export type PluginToolGroup = {
  readonly id: string
  readonly pluginInstanceId: string
  readonly enabled: boolean
  readonly tools: readonly string[]
}

export type PluginSkill = { readonly name: string; readonly description: string; readonly path: string }

export type PluginIcon =
  { readonly kind: "url"; readonly url: string } | { readonly kind: "monogram"; readonly text: string }

export type PluginMcpAuthentication =
  | { readonly state: "local" | "harness" | "public" }
  | { readonly state: "oauth"; readonly integrationId: string; readonly issuers?: readonly string[] }
  | { readonly state: "unavailable"; readonly reason: string }

export type PluginMcpServer = {
  readonly name: string
  readonly type: "stdio" | "streamable-http" | "sse"
  readonly authentication: PluginMcpAuthentication
}

export type PluginComponentDiagnostic = { readonly code: string; readonly path: string; readonly message: string }

export type PluginCandidate = {
  readonly pluginInstanceId: string
  readonly builtIn?: boolean
  readonly groups?: readonly PluginToolGroup[]
  readonly sourceId: string | null
  readonly sourceKind: PluginSourceKind | null
  readonly source: PluginSource | null
  readonly icon?: PluginIcon
  readonly categories?: readonly string[]
  readonly featured?: boolean
  readonly skills: readonly PluginSkill[]
  readonly sourceRevision: string | null
  readonly relativePath: string | null
  readonly candidateDigest: string | null
  readonly sourceAvailable: boolean
  readonly retainedDigest: string | null
  readonly artifactAvailable?: boolean
  readonly artifactError?: string | null
  readonly updateAvailable: boolean
  readonly manifest: {
    readonly name: string
    readonly version?: string | null
    readonly description?: string | null
  } | null
  readonly componentDiagnostics: readonly PluginComponentDiagnostic[]
  readonly mcpServers: readonly PluginMcpServer[]
  readonly harnesses: Readonly<Record<PluginHarness, PluginActivation>>
}

export type MarketplaceCatalogError = {
  readonly sourceId: string
  readonly relativePath: string
  readonly code: string
  readonly message: string
}

export type MarketplaceCatalog = {
  readonly revision: number
  readonly supportedHarnesses: readonly PluginHarness[]
  readonly projects?: readonly { readonly id: string; readonly label: string }[]
  readonly selectedProjectId?: string | null
  readonly canManageOrganizationDefaults?: boolean
  readonly canManageOrganizationConnections?: boolean
  readonly candidates: readonly PluginCandidate[]
  readonly errors: readonly MarketplaceCatalogError[]
}

export type PluginActivationTarget =
  { readonly scope: "all-projects" } | { readonly scope: "projects"; readonly projectIds: readonly string[] }

export type PluginActivationInput = {
  readonly pluginInstanceId: string
  readonly harnessIds: readonly PluginHarness[]
  readonly choice: boolean | null
  readonly revision: number
  readonly target?: PluginActivationTarget
}

export type PluginOrganizationDefaultInput = {
  readonly pluginInstanceId: string
  readonly harnessIds: readonly PluginHarness[]
  readonly choice: true | null
  readonly revision: number
}

export type PluginChange = {
  readonly revision: number
  readonly reconciliation: { readonly state: string; readonly message?: string }
}

export type PluginSkillRequest = {
  readonly pluginInstanceId: string
  readonly skill: string
  readonly projectId?: string
}

export type PluginSkillDocument = { readonly name: string; readonly description: string; readonly markdown: string }

export type PluginSourceRecord = {
  readonly id: string
  readonly kind: PluginSourceKind
  readonly label: string
  readonly repository: string
  readonly ref: string
  readonly authority?: "user" | "organization"
  readonly canRemove: boolean
}

export type PluginSourceInput = {
  readonly owner: string
  readonly repository: string
  readonly ref?: string
  readonly authority?: "user" | "organization"
}

export type PluginSourceDiagnostic = {
  readonly sourceId: string
  readonly relativePath: string
  readonly code: string
  readonly message: string
}

