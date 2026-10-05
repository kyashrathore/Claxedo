import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { codeExtensions, isTranslationFile, listFiles, packageRoot, rel } from "./lib/files"
import { lineCount } from "./lib/parse"
import { finish, type Violation } from "./lib/report"

type Part = { readonly name: string; readonly budget?: number; readonly folders: readonly string[]; readonly except?: readonly string[] }
type Row = { readonly name: string; readonly lines: number; readonly budget: number | undefined; readonly at: string }

const parts: readonly Part[] = [
  { name: "Server adapter", folders: ["src/server"] },
  { name: "Session client", budget: 9500, folders: ["src/session"], except: ["src/session/view"] },
  { name: "Session screen", budget: 14300, folders: ["src/session/view"] },
  { name: "Composer", budget: 12997, folders: ["src/composer"] },
  { name: "Rail and workbench", budget: 8300, folders: ["src/rail", "src/workbench"] },
  { name: "Browser tabs", budget: 1542, folders: ["src/browser"] },
  { name: "Shell and platform", budget: 6977, folders: ["src/shell", "src/auth", "src/i18n", "src/lib", "src/*"], except: ["src/lib/machine.ts"] },
  { name: "Terminal", budget: 4316, folders: ["src/terminal"] },
  { name: "Settings and accounts", budget: 5200, folders: ["src/settings", "src/accounts"] },
  { name: "Access", budget: 1000, folders: ["src/access"] },
  { name: "Review and files", budget: 4357, folders: ["src/review", "src/files"] },
  { name: "Projects and cloud", budget: 3116, folders: ["src/projects", "src/cloud"] },
  { name: "Onboarding and usage", budget: 2094, folders: ["src/onboarding", "src/usage"] },
  { name: "Plugin host", budget: 2099, folders: ["src/plugins"] },
  { name: "Web plugin frame", budget: 917, folders: ["src/plugins/frame"] },
  { name: "Marketplace", budget: 2182, folders: ["src/marketplace"] },
  { name: "Tasks", budget: 4420, folders: ["src/tasks"] },
  { name: "Notifications", budget: 168, folders: ["src/notifications"] },
  { name: "Workspace panel", budget: 1903, folders: ["src/panel"] },
  { name: "State-machine helper", budget: 100, folders: ["src/lib/machine.ts"] },
  { name: "UI kit and transcript renderers", budget: 20000, folders: ["src/ui", "src/transcript"] },
]
const totalBudget = 99666

function main(): never {
  const appFiles = listFiles(packageRoot, ["src"], codeExtensions).filter((file) => !isTranslationFile(packageRoot, file))
  const counted = new Map(parts.map((part) => [part.name, 0]))
  const unmapped = new Set<string>()
  let total = 0
  for (const file of appFiles) {
    const lines = lineCount(readFileSync(file, "utf8"))
    total += lines
    const part = partOf(rel(packageRoot, file))
    if (part) counted.set(part.name, (counted.get(part.name) ?? 0) + lines)
    else unmapped.add(dirname(rel(packageRoot, file)))
  }
  const rows = parts.map((part) => ({ name: part.name, lines: counted.get(part.name) ?? 0, budget: part.budget, at: join(packageRoot, part.folders[0] ?? "src") }))
  const over = printTable([...rows, { name: "Total", lines: total, budget: totalBudget, at: join(packageRoot, "src") }])
  const violations: Violation[] = over.map((row) => ({ file: row.at, line: 1, message: `${row.name} has ${row.lines} lines; the budget is ${row.budget}` }))
  for (const folder of unmapped) violations.push({ file: join(packageRoot, folder), line: 1, message: "not in the budget table; add the part it belongs to" })
  finish("budget", packageRoot, violations, appFiles.length)
}

function partOf(path: string): Part | undefined {
  let best: { part: Part; length: number } | undefined
  for (const part of parts) {
    if (part.except?.some((folder) => matches(path, folder))) continue
    for (const folder of part.folders) {
      if (!matches(path, folder)) continue
      if (!best || folder.length > best.length) best = { part, length: folder.length }
    }
  }
  return best?.part
}

function matches(path: string, folder: string): boolean {
  if (folder === "src/*") return dirname(path) === "src"
  return path === folder || path.startsWith(`${folder}/`)
}

function printTable(rows: readonly Row[]): Row[] {
  const over: Row[] = []
  const width = Math.max(...rows.map((row) => row.name.length), 4)
  for (const row of rows) {
    const budget = row.budget === undefined ? "—" : String(row.budget)
    const excess = row.budget !== undefined && row.lines > row.budget ? row.lines - row.budget : 0
    if (excess > 0) over.push(row)
    const status = excess > 0 ? `OVER by ${excess}` : "ok"
    console.error(`${row.name.padEnd(width)}  ${String(row.lines).padStart(6)}  ${budget.padStart(6)}  ${status}`)
  }
  return over
}

main()
