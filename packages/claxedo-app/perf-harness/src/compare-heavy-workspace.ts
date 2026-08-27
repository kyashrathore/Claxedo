import { compareHeavyWorkspaceNoninferiority, type HeavyWorkspaceReport } from "./heavy-workspace-noninferiority"

const [baselinePath, candidatePath] = process.argv.slice(2)
if (!baselinePath || !candidatePath) {
  console.error("usage: bun src/compare-heavy-workspace.ts <retained-report.json> <disposal-report.json>")
  process.exit(2)
}

const baseline = await Bun.file(baselinePath).json() as HeavyWorkspaceReport
const candidate = await Bun.file(candidatePath).json() as HeavyWorkspaceReport
const result = compareHeavyWorkspaceNoninferiority(baseline, candidate)
console.log(JSON.stringify(result, null, 2))
if (result.status !== "pass") process.exit(1)
