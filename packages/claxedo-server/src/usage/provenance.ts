export type UsageSessionManifestEntry = {
  source: string
  nativeSessionId: string
  sessionRef: string
  harness: string
  workspaceId?: string
  startedAt: number
  endedAt?: number
}

export type UsageProvenance = "claxedo" | "external" | "unclassified"

/**
 * Classify before aggregation. A row without stable native identity is
 * quarantined; it is never assumed external and later subtracted.
 */
export function createUsageProvenanceClassifier(
  entries: readonly UsageSessionManifestEntry[],
  options: { completeSources?: readonly string[] } = {},
) {
  const byNative = new Map(entries.map((entry) => [`${entry.source}\u0000${entry.nativeSessionId}`, entry]))
  const completeSources = new Set(options.completeSources ?? [])
  return (input: { source?: string; nativeSessionId?: string; observedAt: number }): UsageProvenance => {
    if (!input.source || !input.nativeSessionId || !Number.isFinite(input.observedAt)) return "unclassified"
    const match = byNative.get(`${input.source}\u0000${input.nativeSessionId}`)
    if (!match) return completeSources.has(input.source) ? "external" : "unclassified"
    if (input.observedAt < match.startedAt) return "external"
    if (match.endedAt !== undefined && input.observedAt > match.endedAt) return "external"
    return "claxedo"
  }
}
