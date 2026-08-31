import { indexCollection } from "./index-collection"
import type {
  AgentPluginCatalogCandidate,
  AgentPluginCatalogError,
  AgentPluginCollectionIndex,
} from "./types"
import type { CatalogSourceProvider } from "../ports"

export type ResolvedAgentPluginCollections = {
  collections: AgentPluginCollectionIndex[]
  candidates: AgentPluginCatalogCandidate[]
  errors: AgentPluginCatalogError[]
}

export class AgentPluginCatalogCompositionError extends Error {
  constructor(readonly code: "duplicate-source-id", message: string) {
    super(message)
    this.name = "AgentPluginCatalogCompositionError"
  }
}

export async function resolveCollections(
  provider: CatalogSourceProvider,
  options: { fresh?: boolean } = {},
): Promise<ResolvedAgentPluginCollections> {
  const sources = await provider.listAuthorizedSources(options)
  const seen = new Set<string>()
  for (const source of sources) {
    if (seen.has(source.id)) {
      throw new AgentPluginCatalogCompositionError(
        "duplicate-source-id",
        `Agent plugin collection source ${source.id} was supplied more than once`,
      )
    }
    seen.add(source.id)
  }

  const collections = await Promise.all(sources.map(indexCollection))
  return {
    collections,
    candidates: collections.flatMap((collection) => collection.candidates),
    errors: collections.flatMap((collection) => collection.errors),
  }
}
