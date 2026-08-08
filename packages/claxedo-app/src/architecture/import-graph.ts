import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { prodSourcePaths } from "./scanners"

const importPattern =
  /(?:^|[\s;])(import|export)\b([^'"`;()]*?)from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g
const testSupportPathPatterns = [
  /(?:^|\/)_test-helper\.tsx?$/,
  /(?:^|\/)test-support\/.*\.tsx?$/,
  /(?:^|\/)tests\/.*\.tsx?$/,
  /(?:^|\/)[^/]*test-helpers?\.tsx?$/,
]
const typeContractCandidates = new Set([
  // The content-surface shape, shared by the local and hosted surface sets.
  // Both import it type-only ON PURPOSE — that is what keeps the hosted set out
  // of the local runtime graph — so it is reachable by types alone and would
  // otherwise read as orphaned.
  "app/integrations/content-surface-contract.ts",
  "features/extensions/data/types.ts",
  "features/session/data/session-lifecycle.ts",
  // Doorbell event mirrors: the feature owns the event
  // type, the shell folds it into `ClaxedoEvent` with a TYPE-ONLY import — same
  // shape as `session-lifecycle.ts` above, so the graph sees no value edge.
  "features/workgraph/workgraph-changed-event.ts",
  "features/documents/data/document-changed-event.ts",
  "features/session/data/backend/types.ts",
  "features/session/data/query/types.ts",
  "features/session/composer/ui/submit-input.ts",
  "features/session/composer/prompt-input-props.ts",
  "features/terminal/core/backend/types.ts",
  "platform/runtime/workspace-runtime.ts",
  "platform/runtime/capabilities.ts",
  "platform/runtime/session.ts",
  // The workspace-startup port: what local code may ask a hosted build to bring
  // up. Same shape as the account port below — the contract is imported
  // type-only by its caller, its binding, and its cloud implementation, so the
  // value graph sees no edge into it.
  "platform/runtime/workspace-startup-port.ts",
  // The account port: the tokenless account contract. The provider and the
  // browser binding both import it type-only, which is the whole shape — the
  // port declares what may be asked for, and implementations supply it.
  "platform/account/account-port.ts",
  // The machine remote-access port: what "publish this machine" means, with no
  // opinion on whether it is an HTTP call or Electron IPC. Same shape as the
  // account port above — the binder, both implementations and the onboarding
  // controller import it type-only.
  "platform/remote-access/machine-remote-access-port.ts",
  "platform/query/project-meta.ts",
])
const configAliasTargets = new Map([
  ["lru_map", "lib/lru-map.ts"],
])

/**
 * One edge of a product-boundary walk: the module that owned the import, the
 * literal specifier it wrote, and the in-package module it resolved to (null
 * for a bare package specifier, which the walk checks but never follows).
 */
export type ProductImportRef = { specifier: string; module: string | null }

export type ProductBoundaryBreach = {
  /** Module chain from the entry to the module that owns the forbidden import. */
  chain: string[]
  /** The literal specifier that crossed the boundary. */
  specifier: string
  /** The in-package module it resolved to, or null for a bare package. */
  module: string | null
}

/**
 * Walk the transitive VALUE-import graph from one production entry and return
 * the SHORTEST chain that reaches a forbidden edge, or null when the closure is
 * clean.
 *
 * Shortest, not first-found: a depth-first walk reports whichever chain the
 * traversal order happened to reach, which for a graph this size is routinely
 * a twelve-hop path through unrelated modules. Breadth-first makes the reported
 * chain the actual tightest coupling, which is the one a reader has to break.
 *
 * Bare package specifiers are CHECKED but never followed — `@clerk/clerk-js`
 * is a boundary breach wherever it appears, and its own internals are not this
 * package's graph. Type-only imports are excluded because the bundler erases
 * them; an emitted-artifact gate (Unit 12) covers what source scanning cannot.
 */
export function shortestForbiddenImportChain(options: {
  appRoot: string
  /** Entry module, relative to `<appRoot>/src`. */
  entry: string
  isForbidden: (ref: ProductImportRef) => boolean
}): ProductBoundaryBreach | null {
  const { appRoot, entry, isForbidden } = options
  const srcRoot = path.join(appRoot, "src")
  const entryFile = tryFile(path.join(srcRoot, entry))
  if (!entryFile) throw new Error(`entry not found: ${entry}`)

  const entryRel = relative(srcRoot, entryFile)
  const parents = new Map<string, string>()
  const seen = new Set<string>([entryRel])
  let frontier = [entryRel]

  while (frontier.length) {
    const next: string[] = []
    for (const rel of frontier) {
      const file = path.join(srcRoot, rel)
      if (!existsSync(file)) continue
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const resolved = resolveImport(appRoot, file, specifier)
        const module = resolved ? relative(srcRoot, resolved) : null
        if (isForbidden({ specifier, module })) {
          return { chain: chainTo(rel, entryRel, parents), specifier, module }
        }
        if (!module || seen.has(module)) continue
        seen.add(module)
        parents.set(module, rel)
        next.push(module)
      }
    }
    frontier = next
  }

  return null
}

function chainTo(module: string, entry: string, parents: Map<string, string>) {
  const chain = [module]
  let cursor = module
  while (cursor !== entry) {
    const parent = parents.get(cursor)
    if (!parent) break
    chain.unshift(parent)
    cursor = parent
  }
  return chain
}

export function orphanModules(appRoot: string) {
  const srcRoot = path.join(appRoot, "src")
  const reachable = reachableModules(appRoot)
  const exempt = new Set([
    ...typeContractRootModules(appRoot),
    ...reachableTypeContractModules(appRoot, reachable),
    ...configAliasRootModules(appRoot),
  ])
  return prodSourcePaths(appRoot)
    .map((file) => relative(srcRoot, file))
    .filter(isProductionImportGraphPath)
    .filter((file) => !reachable.has(file))
    .filter((file) => !exempt.has(file))
    .sort()
}

function isProductionImportGraphPath(file: string) {
  return !testSupportPathPatterns.some((pattern) => pattern.test(file))
}

export function reachableModules(appRoot: string) {
  const srcRoot = path.join(appRoot, "src")
  const roots = rootFiles(appRoot)
  const reachable = new Set<string>()
  const queue = roots.map((file) => path.join(srcRoot, file))

  while (queue.length) {
    const file = queue.shift()
    if (!file || !existsSync(file)) continue
    const rel = relative(srcRoot, file)
    if (reachable.has(rel)) continue
    reachable.add(rel)

    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveImport(appRoot, file, specifier)
      if (resolved && !reachable.has(relative(srcRoot, resolved))) queue.push(resolved)
    }
  }

  return reachable
}

function rootFiles(appRoot: string) {
  // `local.tsx` is an HTML entry like `main.tsx`: nothing imports it, and
  // without it here the orphan guard reports the local product's entry point
  // as dead code.
  const roots = ["app/entry/main.tsx", "app/entry/local.tsx", "app/entry/index.tsx"].filter((file) => existsSync(path.join(appRoot, "src", file)))
  const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as {
    exports?: Record<string, string>
  }
  return [...new Set([...roots, ...Object.values(pkg.exports ?? {}).flatMap((target) => exportRoots(appRoot, target))])]
}

function exportRoots(appRoot: string, target: string) {
  const normalized = target.replace(/^\.\//, "")
  if (!normalized.includes("*")) return [relative(path.join(appRoot, "src"), path.join(appRoot, normalized))]

  const [before, after] = normalized.split("*")
  const dir = path.join(appRoot, before)
  if (!existsSync(dir)) return []
  const suffix = after ?? ""
  return prodSourcePaths(appRoot).flatMap((file) => {
    const fromApp = relative(appRoot, file)
    if (!fromApp.startsWith(before) || !fromApp.endsWith(suffix)) return []
    return [relative(path.join(appRoot, "src"), file)]
  })
}

export function importSpecifiers(text: string) {
  return parsedImportSpecifiers(text, false)
}

export function allImportSpecifiers(text: string) {
  return parsedImportSpecifiers(text, true)
}

function parsedImportSpecifiers(text: string, includeTypeOnly: boolean) {
  const clean = stripComments(text)
  const specs = new Set<string>()
  let match: RegExpExecArray | null
  importPattern.lastIndex = 0
  while ((match = importPattern.exec(clean))) {
    if (match[5]) {
      specs.add(match[5])
      continue
    }
    if (match[4]) {
      specs.add(match[4])
      continue
    }
    if (!match[3]) continue
    if (!includeTypeOnly && isTypeOnlyClause(match[1], (match[2] ?? "").trim())) continue
    specs.add(match[3])
  }
  return [...specs]
}

function typeOnlyImportSpecifiers(text: string) {
  const clean = stripComments(text)
  const specs = new Set<string>()
  let match: RegExpExecArray | null
  importPattern.lastIndex = 0
  while ((match = importPattern.exec(clean))) {
    if (match[3] && isTypeOnlyClause(match[1], (match[2] ?? "").trim())) specs.add(match[3])
  }
  return [...specs]
}

function reachableTypeContractModules(appRoot: string, reachable: Set<string>) {
  const srcRoot = path.join(appRoot, "src")
  const contracts = new Set<string>()
  for (const rel of reachable) {
    const file = path.join(srcRoot, rel)
    if (!existsSync(file)) continue
    for (const specifier of typeOnlyImportSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveImport(appRoot, file, specifier)
      if (!resolved) continue
      const target = relative(srcRoot, resolved)
      if (!typeContractCandidates.has(target)) continue
      if (isTypeOnlyModule(readFileSync(resolved, "utf8"))) contracts.add(target)
    }
  }
  return contracts
}

function typeContractRootModules(appRoot: string) {
  const srcRoot = path.join(appRoot, "src")
  return [...typeContractCandidates].filter((file) => {
    const absolute = path.join(srcRoot, file)
    return existsSync(absolute) && isTypeOnlyModule(readFileSync(absolute, "utf8"))
  })
}

function isTypeOnlyModule(text: string) {
  const clean = stripComments(text)
  if (/(?:^|[;{}\n])\s*(?:export\s+)?(?:(?:const|let|var|function|class|enum)\s+\w)/.test(clean)) return false
  return importSpecifiers(clean).length === 0
}

function configAliasRootModules(appRoot: string) {
  const configPath = path.join(appRoot, "vite.cloud.config.ts")
  if (!existsSync(configPath)) return []
  const config = readFileSync(configPath, "utf8")
  return [...configAliasTargets].flatMap(([alias, target]) =>
    config.includes(`find: "${alias}"`) && config.includes(`./src/${target}`)
      ? [target]
      : [],
  )
}

export function resolveImport(appRoot: string, fromFile: string, specifier: string) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return tryFile(path.resolve(path.dirname(fromFile), specifier))
  }
  if (specifier === "@claxedo/app") return tryFile(path.join(appRoot, "src/app/entry/index.tsx"))
  if (specifier.startsWith("@claxedo/app/")) {
    if (specifier === "@claxedo/app/i18n") return tryFile(path.join(appRoot, "src/platform/i18n/cloud-strings"))
    if (specifier.startsWith("@claxedo/app/utils/")) {
      return tryFile(path.join(appRoot, "src/lib", specifier.slice("@claxedo/app/utils/".length)))
    }
    return tryFile(path.join(appRoot, "src", specifier.slice("@claxedo/app/".length)))
  }
  if (specifier.startsWith("@/")) return tryFile(path.join(appRoot, "src", specifier.slice(2)))
  if (specifier === "#terminal-backend") return tryFile(path.join(appRoot, "src/features/terminal/core/backend/xterm"))
  return null
}

function tryFile(base: string): string | null {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

function isTypeOnlyClause(keyword: string, clause: string) {
  if (keyword === "export" && /^type\b/.test(clause)) return true
  if (keyword === "import" && /^type\b/.test(clause)) return true
  const named = clause.match(/\{([\s\S]*)\}/)
  const beforeBrace = named ? clause.slice(0, named.index).trim() : clause
  if (beforeBrace.replace(/,/g, "").trim().length > 0) return false
  if (!named) return false
  const bindings = named[1].split(",").map((binding) => binding.trim()).filter(Boolean)
  return bindings.length > 0 && bindings.every((binding) => /^type\b/.test(binding))
}

/**
 * Source with comments blanked out, positions preserved.
 *
 * Exported because guards keep needing it: six guards in one session passed by
 * matching their own doc comments, and every one of them would have been red if
 * it had scanned the code instead of the prose next to it.
 */
export function stripComments(text: string) {
  let output = ""
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code"
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]

    if (state === "line") {
      output += char === "\n" ? "\n" : " "
      if (char === "\n") state = "code"
      continue
    }

    if (state === "block") {
      if (char === "*" && next === "/") {
        output += "  "
        i += 1
        state = "code"
        continue
      }
      output += char === "\n" ? "\n" : " "
      continue
    }

    output += char
    if (state !== "code") {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (
        (state === "single" && char === "'") ||
        (state === "double" && char === "\"") ||
        (state === "template" && char === "`")
      ) state = "code"
      continue
    }

    if (char === "/" && next === "/") {
      output = `${output.slice(0, -1)}  `
      i += 1
      state = "line"
      continue
    }
    if (char === "/" && next === "*") {
      output = `${output.slice(0, -1)}  `
      i += 1
      state = "block"
      continue
    }
    if (char === "'") state = "single"
    if (char === "\"") state = "double"
    if (char === "`") state = "template"
  }
  return output
}

function relative(from: string, file: string) {
  return path.relative(from, file).split(path.sep).join("/")
}
