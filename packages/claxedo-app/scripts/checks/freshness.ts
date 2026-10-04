import { join } from "node:path"
import { applyBaseline, isTestFile, type Baselined, type Candidate } from "./lib/baseline"
import { codeExtensions, listFiles, packageRoot, rel, under } from "./lib/files"
import { freshnessPath, readFreshnessTable, type FreshnessEntry, type FreshnessTable } from "./lib/freshness-table"
import { readSource, startLine, ts } from "./lib/parse"
import { eventsInvalidating, invalidationTablePath, keyReferences, queryKeysPath, readEventInvalidations, readTemplates, type KeyTemplates } from "./lib/query-keys"
import { finish } from "./lib/report"
import { unwrap, walk } from "./lib/tree"

const kinds = new Set(["event-owned", "ttl", "once"])
const optionNames = new Set(["staleTime", "gcTime", "refetchOnMount", "refetchInterval", "refetchOnWindowFocus"])
const defaultsPath = "src/server/server.ts"
const keyPassThroughPath = "src/server/fetch-query.ts"
const declareIn = `declare it in ${freshnessPath}`

const baseline: readonly Baselined[] = [
  { file: "src/tasks/data/queries.ts", matcher: "api.keys.", owner: "tasks", reason: "task reads spread keys derived from queryKeys.tasksAll in src/server/tasks.ts; each read belongs in a query option in src/server/tasks.ts" },
  { file: "src/tasks/data/queries.ts", matcher: "queryKey: current.queryKey", owner: "tasks", reason: "pagedList passes its caller's key through; goes with the task reads above" },
  { file: "src/tasks/data/queries.ts", matcher: "staleTime: 5 * 60_000", owner: "tasks", reason: "task capabilities are re-read after five minutes at the read site; tasksAll is declared once" },
  { file: "src/tasks/presets/capabilities.ts", matcher: "staleTime: 60_000", owner: "tasks", reason: "the preset editor re-reads the plugin catalog after a minute; marketplace is declared once" },
  { file: "src/marketplace/directory-state.ts", matcher: 'refetchOnMount: "always"', owner: "marketplace", reason: "the directory re-reads the plugin catalog on every open; marketplace is declared once" },
  { file: "src/server/account-placements.ts", matcher: "staleTime", owner: "server", reason: "the staleTime is a parameter, 0 on reread and infinity on load; two explicit reads would let the check see both" },
]

type Reference = { readonly file: string; readonly line: number }
type References = { readonly reads: ReadonlyMap<string, Reference>; readonly unknown: readonly Candidate[] }

function main(): never {
  const files = listFiles(packageRoot, ["src"], codeExtensions).filter((file) => !isTestFile(file))
  const templates = readTemplates(packageRoot)
  const table = readFreshnessTable(packageRoot)
  const references = collectReferences(packageRoot, files, templates)
  const ttlNames = new Set(table.entries.filter((entry) => entry.kind === "ttl").map((entry) => entry.name))
  const applied = new Set<string>()
  const candidates: Candidate[] = [
    ...references.unknown,
    ...tableViolations(packageRoot, table, references, templates),
    ...files.flatMap((file) => optionViolations(packageRoot, file, ttlNames, applied)),
    ...unappliedTtl(table, applied),
  ]
  finish("freshness", packageRoot, applyBaseline(packageRoot, baseline, candidates), files.length)
}

function collectReferences(root: string, files: readonly string[], templates: KeyTemplates): References {
  const reads = new Map<string, Reference>()
  const unknown: Candidate[] = []
  for (const file of files) {
    const path = rel(root, file)
    if (!under(root, file, "src/server") || path === queryKeysPath || path === freshnessPath) continue
    const { sf } = readSource(file)
    for (const ref of keyReferences(sf, path === invalidationTablePath)) {
      const line = startLine(ref.node, sf)
      if (!templates.has(ref.name)) unknown.push({ file, line, text: `queryKeys.${ref.name}`, message: `queryKeys.${ref.name} does not exist in ${queryKeysPath}` })
      else if (ref.kind === "read" && !reads.has(ref.name)) reads.set(ref.name, { file, line })
    }
  }
  return { reads, unknown }
}

function tableViolations(root: string, table: FreshnessTable, references: References, templates: KeyTemplates): Candidate[] {
  const declared = new Set(table.entries.map((entry) => entry.name))
  const events = readEventInvalidations(readSource(join(root, invalidationTablePath)).sf)
  const out: Candidate[] = []
  for (const [name, read] of references.reads) {
    if (!declared.has(name)) out.push({ ...read, text: `queryKeys.${name}`, message: `queryKeys.${name} is read here but has no freshness entry; ${declareIn}` })
  }
  for (const entry of table.entries) {
    const message = entryProblem(entry, references, templates, events)
    if (message) out.push({ file: table.file, line: entry.line, text: entry.name, message })
  }
  return out
}

function entryProblem(entry: FreshnessEntry, references: References, templates: KeyTemplates, events: ReturnType<typeof readEventInvalidations>): string | undefined {
  const template = templates.get(entry.name)
  if (!template) return `${entry.name} is not a query key; only names from ${queryKeysPath} declare freshness`
  if (!references.reads.has(entry.name)) return `${entry.name} is never read; it is an invalidation prefix, not a cache, so it declares no freshness`
  const shape = shapeProblem(entry)
  if (shape) return shape
  const computed = eventsInvalidating(template, events, templates)
  if (entry.kind !== "event-owned") {
    return computed.size === 0 ? undefined : `${entry.name} is invalidated by ${[...computed].join(", ")} in ${invalidationTablePath}; declare it event-owned with those events`
  }
  if (computed.size === 0) return `no event in ${invalidationTablePath} invalidates ${entry.name}; declare it once or ttl`
  const declared = new Set(entry.events ?? [])
  const missing = [...computed].filter((event) => !declared.has(event))
  const extra = [...declared].filter((event) => !computed.has(event))
  if (missing.length === 0 && extra.length === 0) return undefined
  return `${entry.name} events differ from ${invalidationTablePath}: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`
}

function shapeProblem(entry: FreshnessEntry): string | undefined {
  if (!entry.kind || !kinds.has(entry.kind)) return `${entry.name} has no kind; use event-owned, ttl or once`
  if (entry.kind === "ttl" && !(entry.ms !== undefined && entry.ms > 0)) return `${entry.name} is a ttl without a positive ms`
  if (entry.kind !== "event-owned" && !entry.reason?.trim()) return `${entry.name} is ${entry.kind} without a reason`
  if (entry.kind === "event-owned" && !entry.events?.length) return `${entry.name} is event-owned without events`
  return undefined
}

function optionViolations(root: string, file: string, ttlNames: ReadonlySet<string>, applied: Set<string>): Candidate[] {
  const path = rel(root, file)
  if (path === defaultsPath) return []
  const { sf } = readSource(file)
  const out: Candidate[] = []
  walk(sf, (node) => {
    if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return
    if (!ts.isIdentifier(node.name)) return
    const name = node.name.text
    const message = optionProblem(node, name, ttlNames, applied) ?? (path === keyPassThroughPath || name !== "queryKey" ? undefined : queryKeyProblem(sf, node))
    if (message) out.push({ file, line: startLine(node, sf), text: node.getText(sf), message })
  })
  return out
}

function optionProblem(node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment, name: string, ttlNames: ReadonlySet<string>, applied: Set<string>): string | undefined {
  if (!optionNames.has(name)) return undefined
  if (name !== "staleTime") return `${name} sets freshness at the read site; a read is fresh by its entry in ${freshnessPath}`
  if (ts.isShorthandPropertyAssignment(node)) return `staleTime is passed in; write 0, Number.POSITIVE_INFINITY or freshness.<name>.ms from ${freshnessPath}`
  const value = unwrap(node.initializer)
  if (ts.isNumericLiteral(value) && Number(value.text) === 0) return undefined
  if (ts.isIdentifier(value) && value.text === "Infinity") return undefined
  if (ts.isPropertyAccessExpression(value) && value.name.text === "POSITIVE_INFINITY" && ts.isIdentifier(value.expression) && value.expression.text === "Number") return undefined
  const ttl = ttlReference(value)
  if (ttl === undefined) return `staleTime ${value.getText()} sets freshness at the read site; ${declareIn} as a ttl and write staleTime: freshness.<name>.ms`
  if (!ttlNames.has(ttl)) return `freshness.${ttl} is not a ttl entry in ${freshnessPath}`
  applied.add(ttl)
  return undefined
}

function ttlReference(value: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(value) || value.name.text !== "ms") return undefined
  const entry = unwrap(value.expression)
  if (!ts.isPropertyAccessExpression(entry) || !ts.isIdentifier(entry.expression) || entry.expression.text !== "freshness") return undefined
  return entry.name.text
}

function queryKeyProblem(sf: ts.SourceFile, node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): string | undefined {
  const value = ts.isPropertyAssignment(node) ? node.initializer : node.name
  if (builtFromQueryKeys(sf, value, new Set())) return undefined
  return `a query key built outside ${queryKeysPath}; reads and their keys live in src/server`
}

function builtFromQueryKeys(sf: ts.SourceFile, expression: ts.Expression, seen: ReadonlySet<string>): boolean {
  const value = unwrap(expression)
  if (mentionsQueryKeys(value)) return true
  if (ts.isIdentifier(value)) {
    if (seen.has(value.text)) return false
    const next = new Set([...seen, value.text])
    return declarationsOf(sf, value.text).some((initializer) => builtFromQueryKeys(sf, initializer, next))
  }
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
    const fn = localFunction(sf, value.expression.text)
    return fn !== undefined && mentionsQueryKeys(fn)
  }
  return false
}

function mentionsQueryKeys(node: ts.Node): boolean {
  let found = false
  walk(node, (child) => {
    if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "queryKeys") found = true
  })
  return found
}

function declarationsOf(sf: ts.SourceFile, name: string): ts.Expression[] {
  const out: ts.Expression[] = []
  walk(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name) return
    if (node.initializer) out.push(node.initializer)
    else if (ts.isVariableDeclarationList(node.parent) && ts.isForOfStatement(node.parent.parent)) out.push(node.parent.parent.expression)
  })
  return out
}

function localFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined
  walk(sf, (node) => {
    if (!found && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
  })
  return found
}

function unappliedTtl(table: FreshnessTable, applied: ReadonlySet<string>): Candidate[] {
  return table.entries
    .filter((entry) => entry.kind === "ttl" && !applied.has(entry.name))
    .map((entry) => ({ file: table.file, line: entry.line, text: entry.name, message: `${entry.name} declares a ttl that no read applies; write staleTime: freshness.${entry.name}.ms at its read or declare it once` }))
}

main()
