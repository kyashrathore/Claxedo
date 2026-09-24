import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve as resolvePath } from "node:path"
import { codeExtensions, listFiles, parseArgs, rel, repoRoot, styleExtensions, under } from "./lib/files"
import { compilerOptions, createResolver, importsOf, readSource, startLine, type Resolver, type Source } from "./lib/parse"
import { finish, type Violation } from "./lib/report"

const retiredKits = ["packages/ui", "packages/session-ui", "packages/storybook"]
const styleImport = /@import\s+(?:url\()?["']([^"']+)["']/g
const tokenPattern = /--[a-z][a-z0-9-]*/g

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const resolve = createResolver(compilerOptions())
  const tokens = new Set(readFileSync(join(import.meta.dir, "data/v1-tokens.txt"), "utf8").split("\n").filter(Boolean))
  const codeFiles = listFiles(root, ["src", "e2e", "plugins"], codeExtensions)
  const styleFiles = listFiles(root, ["src", "plugins"], styleExtensions)
  const violations: Violation[] = []
  for (const file of codeFiles) {
    const source = readSource(file)
    violations.push(...retiredImports(root, source, resolve), ...retiredTokens(file, source.text, tokens))
  }
  for (const file of styleFiles) {
    const text = readFileSync(file, "utf8")
    violations.push(...retiredStyleImports(root, file, text, resolve), ...retiredTokens(file, text, tokens))
  }
  finish("v2-only", root, violations, codeFiles.length + styleFiles.length)
}

function retiredImports(root: string, { file, sf }: Source, resolve: Resolver): Violation[] {
  const violations: Violation[] = []
  for (const { specifier, node } of importsOf(sf)) {
    const reason = retiredTarget(root, specifier, resolve(file, specifier))
    if (reason) violations.push({ file, line: startLine(node, sf), message: reason })
  }
  return violations
}

function retiredStyleImports(root: string, file: string, text: string, resolve: Resolver): Violation[] {
  const violations: Violation[] = []
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(styleImport)) {
      const specifier = match[1] ?? ""
      const target = specifier.startsWith(".") ? realPath(resolvePath(dirname(file), specifier)) : resolve(file, specifier)
      const reason = retiredTarget(root, specifier, target)
      if (reason) violations.push({ file, line: index + 1, message: reason })
    }
  })
  return violations
}

function realPath(path: string): string | undefined {
  return existsSync(path) ? realpathSync(path) : undefined
}

function retiredTarget(root: string, specifier: string, target: string | undefined): string | undefined {
  if (specifier.startsWith("@opencode-ai/")) return `imports the v1 kit ${specifier}; use src/ui or src/transcript`
  if (!target) return undefined
  if (under(root, target, "src/legacy")) return `imports the old app (${rel(root, target)}); v2 code imports only v2 code`
  const kit = retiredKits.find((folder) => under(repoRoot, target, folder))
  return kit ? `imports ${kit} through ${specifier}; use src/ui or src/transcript` : undefined
}

function retiredTokens(file: string, text: string, tokens: ReadonlySet<string>): Violation[] {
  const violations: Violation[] = []
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(tokenPattern)) {
      const before = match.index > 0 ? line[match.index - 1] : undefined
      if (before !== undefined && /[\w-]/.test(before)) continue
      if (!tokens.has(match[0])) continue
      violations.push({ file, line: index + 1, message: `uses the v1 token ${match[0]}; use the v2 kit's tokens` })
    }
  })
  return violations
}

main()
