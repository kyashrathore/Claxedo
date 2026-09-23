import { queryOptions } from "@tanstack/solid-query"
import type { ProjectId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"

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

export type PluginCandidate = {
  readonly pluginInstanceId: string
  readonly builtIn?: boolean
  readonly groups?: readonly { readonly id: string; readonly pluginInstanceId: string; readonly enabled: boolean; readonly tools: readonly string[] }[]
  readonly source: PluginSource | null
  readonly icon?: { readonly kind: "url"; readonly url: string } | { readonly kind: "monogram"; readonly text: string }
  readonly categories?: readonly string[]
  readonly featured?: boolean
  readonly skills: readonly { readonly name: string; readonly description: string; readonly path: string }[]
  readonly sourceAvailable: boolean
  readonly artifactAvailable?: boolean
  readonly artifactError?: string
  readonly updateAvailable: boolean
  readonly manifest: { readonly name: string; readonly version?: string; readonly description?: string } | null
  readonly harnesses: Readonly<Record<PluginHarness, PluginActivation>>
}

export type MarketplaceCatalog = {
  readonly revision: number
  readonly supportedHarnesses: readonly PluginHarness[]
  readonly projects?: readonly { readonly id: string; readonly label: string }[]
  readonly selectedProjectId?: string | null
  readonly candidates: readonly PluginCandidate[]
  readonly errors: readonly { readonly sourceId: string; readonly relativePath: string; readonly code: string; readonly message: string }[]
}

export function marketplaceQueries(transport: Transport) {
  return {
    catalog: (projectId?: ProjectId) => queryOptions({
      queryKey: queryKeys.marketplace(transport.serverUrl, projectId),
      queryFn: () => transport.json<MarketplaceCatalog>(withQuery("/api/claxedo/plugins", { project: projectId })),
    }),
  }
}
