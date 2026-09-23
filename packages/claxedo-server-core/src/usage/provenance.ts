export type UsageSessionManifestEntry = {
  source: string
  nativeSessionId: string
  sessionRef: string
  harness: string
  workspaceId?: string
  /** When the turn began. A window opened at a later observation files the turn's earlier requests as external. */
  startedAt: number
  endedAt?: number
}

export type UsageProvenance = "claxedo" | "external" | "unclassified"

export function tokenTrackerSourceForHarness(harness: string) {
  // An ACP connection is metered as `connection:<agent id>`; the agent it runs,
  // not the rail, is what writes the native history.
  const agent = harness.startsWith("connection:") ? harness.slice("connection:".length) : harness
  if (agent === "pi") return "pi"
  if (agent === "opencode") return "opencode"
  if (agent.startsWith("claude")) return "claude"
  if (agent.startsWith("codex")) return "codex"
  if (agent.startsWith("cursor")) return "cursor"
  return undefined
}

/**
 * Classify before aggregation. A row without stable native identity is
 * quarantined; it is never assumed external and later subtracted.
 *
 * A native session is Claxedo's only inside the windows its entries name, one
 * per turn: the same native session can be resumed outside Claxedo between
 * them.
 */
export function createUsageProvenanceClassifier(
  entries: readonly UsageSessionManifestEntry[],
  options: { completeSources?: readonly string[]; completeAfter?: Readonly<Record<string, number>> } = {},
) {
  const windowsByNative = new Map<string, UsageSessionManifestEntry[]>()
  for (const entry of entries) {
    const key = `${entry.source}\u0000${entry.nativeSessionId}`
    const windows = windowsByNative.get(key)
    if (windows) windows.push(entry)
    else windowsByNative.set(key, [entry])
  }
  const completeSources = new Set(options.completeSources ?? [])
  return (input: { source?: string; nativeSessionId?: string; observedAt: number }): UsageProvenance => {
    if (!input.source || !input.nativeSessionId || !Number.isFinite(input.observedAt)) return "unclassified"
    const windows = windowsByNative.get(`${input.source}\u0000${input.nativeSessionId}`)
    if (!windows) {
      const boundary = options.completeAfter?.[input.source]
      return completeSources.has(input.source) || (boundary !== undefined && input.observedAt >= boundary)
        ? "external"
        : "unclassified"
    }
    return windows.some((window) =>
      input.observedAt >= window.startedAt && (window.endedAt === undefined || input.observedAt <= window.endedAt))
      ? "claxedo"
      : "external"
  }
}
