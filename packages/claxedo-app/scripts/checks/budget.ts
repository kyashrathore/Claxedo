import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { codeExtensions, isTranslationFile, listFiles, parseArgs, pluginsDirectory, rel, topFolder } from "./lib/files"
import { lineCount } from "./lib/parse"
import { finish, type Violation } from "./lib/report"

type Part = { readonly name: string; readonly budget?: number; readonly folders: readonly string[]; readonly except?: readonly string[] }
type Row = { readonly name: string; readonly lines: number; readonly budget: number | undefined; readonly at: string }

const parts: readonly Part[] = [
  { name: "Server adapter (no budget until its dedicated rebuild; DECISIONS 2026-09-26)", folders: ["src/server"] },
  { name: "Session client, including the session list store", budget: 9500, folders: ["src/session"], except: ["src/session/view"] },
  { name: "Session screen incl. the kept timeline and docks", budget: 14300, folders: ["src/session/view"] },
  { name: "Composer (re-based to its measured size: the known-selection seed and its tests plus the kit v2 controls (DECISIONS 2026-09-26), and a draft's first send taking its text out and giving it back on refusal)", budget: 11181, folders: ["src/composer"] },
  { name: "Rail and workbench", budget: 8300, folders: ["src/rail", "src/workbench"] },
  { name: "Browser tabs (re-based to its measured size: the parity ruling kept v1's chrome; DECISIONS 2026-09-26)", budget: 1375, folders: ["src/browser"] },
  { name: "Shell and platform (re-based to its measured size: the desktop's local-service-lost alert; DECISIONS 2026-09-27)", budget: 6617, folders: ["src/shell", "src/auth", "src/i18n", "src/lib", "src/*"], except: ["src/lib/machine.ts"] },
  { name: "Terminal", budget: 4300, folders: ["src/terminal"] },
  { name: "Settings, with accounts and machines", budget: 5200, folders: ["src/settings", "src/accounts", "src/machines"] },
  { name: "Access", budget: 1000, folders: ["src/access"] },
  { name: "Review, git, files", budget: 4300, folders: ["src/review", "src/files", "src/git"] },
  { name: "Projects and cloud", budget: 3000, folders: ["src/projects", "src/cloud"] },
  { name: "Onboarding and usage", budget: 1800, folders: ["src/onboarding", "src/usage"] },
  { name: "Plugin host (re-based to its measured size after the frame split: per-manifest approval and the App plugins settings; DECISIONS 2026-09-26)", budget: 2070, folders: ["src/plugins"] },
  { name: "Web plugin frame: the sandboxed frame runtime and its host bridge (split from the plugin host; DECISIONS 2026-09-26)", budget: 864, folders: ["src/plugins/frame"] },
  { name: "Marketplace (re-based to its measured size: v1's directory ported under the parity rule; DECISIONS 2026-09-26)", budget: 2353, folders: ["src/marketplace"] },
  { name: "Tasks, an app domain (re-based to its measured size; the plan's 2.5k was the Tasks plugin's; DECISIONS 2026-09-26)", budget: 4419, folders: ["src/tasks"] },
  { name: "Notifications (no plan number; measured 2026-09-25, for review)", budget: 129, folders: ["src/notifications"] },
  { name: "Workspace panel (re-based to its measured size: the navigator's exposed-view hold shared with the panel frame, the open control's press-time root listing, and the navigator width both the column and its content read; DECISIONS 2026-09-27)", budget: 1761, folders: ["src/panel"] },
  { name: "Moved in from the session feature (lands in rail and review)", budget: 600, folders: [] },
  { name: "State-machine helper", budget: 100, folders: ["src/lib/machine.ts"] },
  { name: "UI kit (src/ui) and kept transcript renderers (src/transcript)", budget: 20000, folders: ["src/ui", "src/transcript"] },
]
const totalBudget = 94000
const pluginsBudget = 7000
const pluginBudgets: Readonly<Record<string, number>> = { pages: 3000, "compact-tabs": 600, "codex-theme": 600 }

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const appFiles = listFiles(root, ["src"], codeExtensions).filter((file) => !isTranslationFile(root, file))
  const counted = new Map(parts.map((part) => [part.name, 0]))
  const unmapped = new Set<string>()
  let total = 0
  for (const file of appFiles) {
    const lines = lineCount(readFileSync(file, "utf8"))
    total += lines
    const part = partOf(rel(root, file))
    if (part) counted.set(part.name, (counted.get(part.name) ?? 0) + lines)
    else unmapped.add(dirname(rel(root, file)))
  }
  const rows = parts.map((part) => ({ name: part.name, lines: counted.get(part.name) ?? 0, budget: part.budget, at: join(root, part.folders[0] ?? "src") }))
  const over = [...printTable([...rows, { name: "Total", lines: total, budget: totalBudget, at: join(root, "src") }]), ...printTable(pluginLines(root))]
  const violations: Violation[] = over.map((row) => ({ file: row.at, line: 1, message: `${row.name} has ${row.lines} lines; the budget is ${row.budget}` }))
  for (const folder of unmapped) violations.push({ file: join(root, folder), line: 1, message: "not in the budget table; add the part it belongs to" })
  finish("budget", root, violations, appFiles.length)
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

function pluginLines(root: string): Row[] {
  const byPlugin = new Map<string, number>()
  let total = 0
  for (const file of listFiles(root, ["plugins"], codeExtensions).filter((file) => !isTranslationFile(root, file))) {
    const plugin = topFolder(root, file, "plugins") ?? "(root)"
    const lines = lineCount(readFileSync(file, "utf8"))
    byPlugin.set(plugin, (byPlugin.get(plugin) ?? 0) + lines)
    total += lines
  }
  const plugins = pluginsDirectory(root)
  const rows = [...byPlugin].sort().map(([plugin, lines]) => ({ name: `plugins/${plugin}`, lines, budget: pluginBudgets[plugin], at: join(plugins, plugin) }))
  return rows.length === 0 ? [] : [...rows, { name: "First-party plugins total", lines: total, budget: pluginsBudget, at: plugins }]
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
