import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { asAnyCastFindings, lineCounts, metricCounts, walkProdSources, walkTestSources } from "../src/architecture/scanners"
import { orphanModules } from "../src/architecture/import-graph"
import productionSetIntervalAllowlist from "../src/architecture/production-set-interval-allowlist.json"

const appRoot = path.resolve(import.meta.dir, "..")
const baselinePath = path.join(appRoot, "src/architecture/debt-baseline.json")
const sizeBaselinePath = path.join(appRoot, "src/architecture/size-baseline.json")
const orphanBaselinePath = path.join(appRoot, "src/architecture/orphan-baseline.json")
const counts = {
  ...metricCounts(walkProdSources(appRoot)),
  asAnyCastsTest: asAnyCastFindings(walkTestSources(appRoot)).length,
  productionTimerAllowlistTimers: productionSetIntervalAllowlist.reduce((sum, entry) => sum + entry.count, 0),
}

writeFileSync(
  baselinePath,
  `${JSON.stringify(counts, Object.keys(counts).sort(), 2)}\n`,
)

console.log(`Updated ${path.relative(appRoot, baselinePath)}`)

if (process.argv.includes("--sizes") || !existsSync(sizeBaselinePath)) {
  const oversized = Object.fromEntries(
    lineCounts(appRoot)
      .filter((entry) => entry.lines > 800)
      .sort((left, right) => left.file.localeCompare(right.file))
      .map((entry) => [entry.file, entry.lines]),
  )
  writeFileSync(sizeBaselinePath, `${JSON.stringify(oversized, null, 2)}\n`)
  console.log(`Updated ${path.relative(appRoot, sizeBaselinePath)}`)
}

if (process.argv.includes("--orphans") || !existsSync(orphanBaselinePath)) {
  writeFileSync(orphanBaselinePath, `${JSON.stringify(orphanModules(appRoot), null, 2)}\n`)
  console.log(`Updated ${path.relative(appRoot, orphanBaselinePath)}`)
}
