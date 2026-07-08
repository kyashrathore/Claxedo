import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { lineCounts, metricCounts, walkProdSources, walkTestSources } from "../src/architecture/scanners"
import { orphanModules } from "../src/architecture/import-graph"
import productionSetIntervalAllowlist from "../src/architecture/production-set-interval-allowlist.json"

const appRoot = path.resolve(import.meta.dir, "..")
const baselinePath = path.join(appRoot, "src/architecture/debt-baseline.json")
const sizeAllowlistPath = path.join(appRoot, "src/architecture/size-allowlist.json")
const orphanBaselinePath = path.join(appRoot, "src/architecture/orphan-baseline.json")
const counts = {
  ...metricCounts(walkProdSources(appRoot)),
  asAnyCastsTest: walkTestSources(appRoot).reduce(
    (count, file) => count + (file.text.match(/as any|as unknown as/g)?.length ?? 0),
    0,
  ),
  productionTimerAllowlistTimers: productionSetIntervalAllowlist.reduce((sum, entry) => sum + entry.count, 0),
}

writeFileSync(
  baselinePath,
  `${JSON.stringify(counts, Object.keys(counts).sort(), 2)}\n`,
)

console.log(`Updated ${path.relative(appRoot, baselinePath)}`)

if (process.argv.includes("--sizes") || !existsSync(sizeAllowlistPath)) {
  const oversized = Object.fromEntries(
    lineCounts(appRoot)
      .filter((entry) => entry.lines > 800)
      .sort((left, right) => left.file.localeCompare(right.file))
      .map((entry) => [entry.file, entry.lines]),
  )
  writeFileSync(sizeAllowlistPath, `${JSON.stringify(oversized, null, 2)}\n`)
  console.log(`Updated ${path.relative(appRoot, sizeAllowlistPath)}`)
}

if (process.argv.includes("--orphans") || !existsSync(orphanBaselinePath)) {
  writeFileSync(orphanBaselinePath, `${JSON.stringify(orphanModules(appRoot), null, 2)}\n`)
  console.log(`Updated ${path.relative(appRoot, orphanBaselinePath)}`)
}
