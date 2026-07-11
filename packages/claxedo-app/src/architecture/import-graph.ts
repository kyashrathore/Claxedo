import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { prodSourcePaths } from "./scanners"

const importPattern =
  /(?:^|[\s;])(import|export)\b([^'"`;()]*?)from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g
const testSupportPathPatterns = [
  /(?:^|\/)_test-helper\.tsx?$/,
  /(?:^|\/)tests\/.*\.tsx?$/,
  /(?:^|\/)[^/]*test-helpers?\.tsx?$/,
]
const typeContractCandidates = new Set([
  "extensions/types.ts",
  "shared/data/session-lifecycle.ts",
  "shared/data/types.ts",
  "shared/query/types.ts",
  "session-client/composer/prompt-input-props.ts",
  "terminal/backend/types.ts",
])
const configAliasTargets = new Map([
  ["lru_map", "utils/lru-map.ts"],
])

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
  const roots = ["main.tsx", "index.tsx"].filter((file) => existsSync(path.join(appRoot, "src", file)))
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
    if (!match[3] || isTypeOnlyClause(match[1], (match[2] ?? "").trim())) continue
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
  if (specifier === "@opencode-ai/claxedo-app") return tryFile(path.join(appRoot, "src/index.tsx"))
  if (specifier.startsWith("@opencode-ai/claxedo-app/")) {
    return tryFile(path.join(appRoot, "src", specifier.slice("@opencode-ai/claxedo-app/".length)))
  }
  if (specifier.startsWith("@/")) return tryFile(path.join(appRoot, "src", specifier.slice(2)))
  if (specifier.startsWith("@claxedo/")) return tryFile(path.join(appRoot, "src", specifier.slice("@claxedo/".length)))
  if (specifier === "#terminal-backend") return tryFile(path.join(appRoot, "src/terminal/backend/xterm"))
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

function stripComments(text: string) {
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
