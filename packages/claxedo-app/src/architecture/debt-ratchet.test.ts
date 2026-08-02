import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { metricCounts, metrics, walkProdSources, walkTestSources, type Finding, type MetricName, type SourceFile } from "./scanners"
import productionSetIntervalAllowlist from "./production-set-interval-allowlist.json"

const appRoot = path.resolve(import.meta.dir, "../..")
const baselinePath = path.join(import.meta.dir, "debt-baseline.json")
type DebtMetricName = MetricName | "asAnyCastsTest" | "productionTimerAllowlistTimers"
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<DebtMetricName, number>
const findings = new Map(metrics.map((metric) => [metric.name, metric.scan(walkProdSources(appRoot))]))
const live = metricCounts(walkProdSources(appRoot))
const testAsAnyFindings = asAnyFindings(walkTestSources(appRoot))
const testAsAnyCount = testAsAnyFindings.length

describe("architecture debt ratchet", () => {
  for (const metric of metrics) {
    test(`${metric.name} is exactly pinned`, () => {
      assertRatchet(metric.name, live[metric.name], baseline[metric.name], findings.get(metric.name) ?? [])
    })
  }

  test("production setInterval allowlist entries are live and named", () => {
    const sources = walkProdSources(appRoot)
    const offenders = productionSetIntervalAllowlist.flatMap((entry) => {
      if (!entry.owner) return [`${entry.file}: owner is required`]
      if (!entry.reason) return [`${entry.file}: reason is required`]
      const source = sources.find((file) => file.path === entry.file)
      if (!source) return [`${entry.file}: allowlisted file is missing`]
      const count = source.text.match(/setInterval\s*\(/g)?.length ?? 0
      if (count < entry.count) return [`${entry.file}: allowlist expects ${entry.count} setInterval calls but found ${count}`]
      return []
    })

    expect(offenders).toEqual([])
  })

  test("production timer allowlist count is pinned", () => {
    assertRatchet(
      "productionTimerAllowlistTimers",
      productionSetIntervalAllowlist.reduce((sum, entry) => sum + entry.count, 0),
      baseline.productionTimerAllowlistTimers,
      [],
    )
  })

  test("asAnyCastsTest is exactly pinned", () => {
    assertRatchet("asAnyCastsTest", testAsAnyCount, baseline.asAnyCastsTest, testAsAnyFindings)
  })

  test("combined production and test as-any casts stay below the phase target", () => {
    expect(live.asAnyCasts + testAsAnyCount).toBeLessThan(50)
  })

  test("surviving as-any casts carry local justification comments", () => {
    expect(unjustifiedAsAnyFindings([...walkProdSources(appRoot), ...walkTestSources(appRoot)])).toEqual([])
  })
})

function assertRatchet(name: DebtMetricName, actual: number, expected: number | undefined, offenders: Finding[]) {
  expect(expected, `${name} is missing from debt-baseline.json`).toBeNumber()
  if (actual === expected) return

  const direction = actual > (expected ?? 0) ? "regressed" : "improved"
  const instruction =
    direction === "regressed"
      ? `do not add new ${name} debt`
      : "run 'bun run scripts/update-debt-baseline.ts' and commit the new baseline in this same commit"

  expect(actual, `${name} ${direction}: ${actual} != baseline ${expected} -- ${instruction}\n${topOffenders(offenders)}`).toBe(
    expected,
  )
}

function asAnyFindings(files: SourceFile[]) {
  return files.flatMap((file) =>
    file.text.split("\n").flatMap((line, index) =>
      [...line.matchAll(/as any|as unknown as/g)].map((match) => ({
        file: file.path,
        line: index + 1,
        match: match[0],
      })),
    ),
  )
}

function unjustifiedAsAnyFindings(files: SourceFile[]) {
  return asAnyFindings(files).flatMap((finding) => {
    const source = files.find((file) => file.path === finding.file)
    if (!source) return [finding]
    const lines = source.text.split("\n")
    const window = lines.slice(Math.max(0, finding.line - 2), finding.line + 1).join("\n")
    if (window.includes("as-any:")) return []
    return [finding]
  })
}

function topOffenders(offenders: Finding[]) {
  return offenders
    .slice(0, 5)
    .map((finding) => `  ${finding.file}:${finding.line}: ${finding.match}`)
    .join("\n")
}
