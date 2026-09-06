import { compareHeavyWorkspaceNoninferiority, parseHeavyWorkspaceReport } from "./heavy-workspace-noninferiority"

const [baselinePath, candidatePath] = process.argv.slice(2)
if (!baselinePath || !candidatePath) {
  console.error("usage: bun src/compare-heavy-workspace.ts <retained-report.json> <disposal-report.json>")
  process.exit(2)
}

const baseline = parseHeavyWorkspaceReport(await Bun.file(baselinePath).json())
const candidate = parseHeavyWorkspaceReport(await Bun.file(candidatePath).json())
const result = compareHeavyWorkspaceNoninferiority(baseline, candidate)
console.log(JSON.stringify(result, null, 2))
if (result.status !== "pass") process.exit(1)
