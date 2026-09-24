import { codeExtensions, listFiles, parseArgs, rel, topFolder, under } from "./lib/files"
import { compilerOptions, createResolver, importsOf, readSource, startLine } from "./lib/parse"
import { finish, type Violation } from "./lib/report"

type Unit = { readonly kind: "domain" | "plugin" | "shared" | "root" | "outside"; readonly name: string }

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const resolve = createResolver(compilerOptions())
  const files = listFiles(root, ["src", "plugins"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    const { sf } = readSource(file)
    const home = unitOf(root, file)
    for (const { specifier, node } of importsOf(sf)) {
      const target = resolve(file, specifier)
      const message = target ? crossing(root, home, target) : undefined
      if (message) violations.push({ file, line: startLine(node, sf), message: `${message} (${specifier})` })
    }
  }
  finish("domain-boundaries", root, violations, files.length)
}

function unitOf(root: string, file: string): Unit {
  const domain = topFolder(root, file, "src")
  if (domain === "lib") return { kind: "shared", name: domain }
  if (domain) return { kind: "domain", name: domain }
  if (under(root, file, "src")) return { kind: "root", name: "src" }
  const plugin = topFolder(root, file, "plugins")
  if (plugin) return { kind: "plugin", name: plugin }
  return { kind: "outside", name: "" }
}

function crossing(root: string, home: Unit, target: string): string | undefined {
  const unit = unitOf(root, target)
  if (unit.kind === "outside" || unit.kind === "shared" || unit.kind === "root") return undefined
  if (unit.kind === home.kind && unit.name === home.name) return undefined
  if (unit.kind === "plugin") return `imports plugin ${unit.name}; plugins share code only through the plugin api`
  const path = rel(root, target)
  if (path === `src/${unit.name}/index.ts` || path === `src/${unit.name}/index.tsx`) return undefined
  return `imports ${path} directly; import the domain through src/${unit.name}/index.ts`
}

main()
