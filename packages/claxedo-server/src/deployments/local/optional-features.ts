export type LocalOptionalFeatures = Readonly<{
  documents: boolean
  workgraph: boolean
}>

export function localOptionalFeatures(env: Record<string, string | undefined> = process.env): LocalOptionalFeatures {
  return {
    documents: env.CLAXEDO_ENABLE_DOCUMENTS === "1",
    workgraph: env.CLAXEDO_ENABLE_WORKGRAPH === "1",
  }
}

export function localOptionalProxyRoutes(features: LocalOptionalFeatures) {
  if (!features.documents) return []
  return ["/documents", "/documents/*", "/internal/documents", "/internal/documents/*"] as const
}
