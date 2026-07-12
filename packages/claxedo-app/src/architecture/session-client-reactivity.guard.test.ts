import { describe, expect, test } from "bun:test"
import path from "node:path"
import { metrics, walkProdSources } from "./scanners"
import baseline from "./session-client-reactivity-baseline.json"

const appRoot = path.resolve(import.meta.dir, "../..")

/**
 * The composer subsystem (`features/session/{composer,harness,commands}/`,
 * formerly `session-client/`) is the isolated composer surface: it should stay free of
 * ad-hoc Solid write-effects, raw `props` destructuring, and suppression-flag
 * escape hatches so its reactive timing stays easy to reason about. This is a
 * live invariant (not a one-time migration pin) -- new debt here is exactly
 * the kind of footgun the subsystem was isolated to avoid.
 */
const SESSION_CLIENT_METRICS = ["effectStateWrites", "propsDestructuring", "suppressionFlags"] as const
type SessionClientMetric = (typeof SESSION_CLIENT_METRICS)[number]

const COMPOSER_SUBSYSTEM_PREFIXES = [
  "features/session/composer/",
  "features/session/harness/",
  "features/session/commands/",
] as const

function scanSessionClient(metric: SessionClientMetric) {
  return metrics
    .find((item) => item.name === metric)!
    .scan(
      walkProdSources(appRoot).filter((file) =>
        COMPOSER_SUBSYSTEM_PREFIXES.some((prefix) => file.path.startsWith(prefix)),
      ),
    )
}

function countsByFile(metric: SessionClientMetric) {
  const counts = new Map<string, number>()
  for (const finding of scanSessionClient(metric)) {
    counts.set(finding.file, (counts.get(finding.file) ?? 0) + 1)
  }
  return counts
}

describe("session-client reactivity guard", () => {
  test("keeps session-client's write-effects, props destructuring, and suppression flags within the shrink-only baseline", () => {
    const allowed = new Map(baseline.map((entry) => [`${entry.metric}:${entry.file}`, entry.count]))
    const offenders: string[] = []

    for (const metric of SESSION_CLIENT_METRICS) {
      for (const [file, count] of countsByFile(metric)) {
        const allowedCount = allowed.get(`${metric}:${file}`) ?? 0
        if (count > allowedCount) {
          offenders.push(
            `${metric} regressed in ${file}: ${count} > baseline ${allowedCount} -- do not add new session-client reactivity debt`,
          )
        }
      }
    }

    expect(offenders).toEqual([])
  })

  test("keeps the reactivity baseline pruned as session-client sheds debt", () => {
    const offenders = baseline.flatMap((entry) => {
      const metric = entry.metric as SessionClientMetric
      const live = countsByFile(metric).get(entry.file) ?? 0
      if (live >= entry.count) return []
      return [
        `${entry.metric}:${entry.file}: baseline allows ${entry.count}, only ${live} remain -- lower the count in session-client-reactivity-baseline.json`,
      ]
    })

    expect(offenders).toEqual([])
  })
})
