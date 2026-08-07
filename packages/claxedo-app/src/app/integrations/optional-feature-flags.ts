export type OptionalFeatureFlags = Readonly<{
  documents: boolean
  workgraph: boolean
}>

export function optionalFeatureFlags(): OptionalFeatureFlags {
  const runtime = typeof window === "undefined" ? undefined : window.__OPENCODE__
  const desktop =
    typeof window === "undefined"
      ? undefined
      : (window as typeof window & { api?: { optionalFeatures?: OptionalFeatureFlags } }).api?.optionalFeatures
  return {
    documents:
      desktop?.documents === true ||
      runtime?.documentsEnabled === true ||
      import.meta.env.VITE_CLAXEDO_ENABLE_DOCUMENTS === "1",
    workgraph:
      desktop?.workgraph === true ||
      runtime?.workgraphEnabled === true ||
      import.meta.env.VITE_CLAXEDO_ENABLE_WORKGRAPH === "1",
  }
}
