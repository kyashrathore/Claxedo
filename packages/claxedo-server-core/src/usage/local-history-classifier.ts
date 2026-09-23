import type { TurnUsageRevision } from "./contracts"
import { createUsageProvenanceClassifier, tokenTrackerSourceForHarness, type UsageSessionManifestEntry } from "./provenance"

/** A turn this machine metered, and when its first revision was observed. */
export type LocalTurnSpan = { fact: TurnUsageRevision; startedAt: number }

/**
 * Every turn this machine metered, as the manifest a scan of its CLI history
 * is classified against: one entry per turn, over the window the turn ran in.
 * A cloud workspace's native sessions live in its sandbox's home, never in
 * this machine's history, so only local turns are entered. A source with a
 * metered turn that names no native session cannot prove any row external.
 */
export function localTurnManifest(spans: readonly LocalTurnSpan[]) {
  const entries: UsageSessionManifestEntry[] = []
  const incompleteSources = new Set<string>()
  for (const { fact, startedAt } of spans) {
    if (fact.location !== "local") continue
    const source = tokenTrackerSourceForHarness(fact.harness)
    if (!source) continue
    const nativeSessionId = fact.nativeSessionId ?? (source === "pi" ? fact.sessionId : undefined)
    if (!nativeSessionId) {
      incompleteSources.add(source)
      continue
    }
    entries.push({
      source,
      nativeSessionId,
      sessionRef: fact.sessionRef,
      harness: fact.harness,
      ...(fact.workspaceId ? { workspaceId: fact.workspaceId } : {}),
      startedAt,
      ...(fact.completedAt === undefined ? {} : { endedAt: fact.completedAt }),
    })
  }
  return { entries, incompleteSources }
}

/**
 * The classifier a scan of this machine's CLI history runs, for every
 * deployment that serves one. `coverageStarts` is when each source's turns
 * began to be metered here: a row after it that no turn claims is another
 * tool's, and a row before it stays unclassified.
 */
export function localHistoryClassifier(
  spans: readonly LocalTurnSpan[],
  coverageStarts: Readonly<Record<string, number>>,
) {
  const { entries, incompleteSources } = localTurnManifest(spans)
  const completeAfter = Object.fromEntries(
    Object.entries(coverageStarts).filter(([source]) => !incompleteSources.has(source)),
  )
  return createUsageProvenanceClassifier(entries, { completeAfter })
}
