import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import { codeExtensions, listFiles, parseArgs, rel, repoRoot, styleExtensions, under } from "./lib/files"
import { compilerOptions, createResolver, importsOf, readSource, startLine, type Resolver, type Source } from "./lib/parse"
import { finish, type Violation } from "./lib/report"

const kitFolders = ["packages/ui", "packages/session-ui", "packages/storybook"]
const kitDoor = "src/ui"
const sessionKit = "packages/session-ui"
const kitStylesheets: Readonly<Record<string, readonly string[]>> = {
  "src/shell/styles/index.css": ["@opencode-ai/ui/styles/tailwind", "@opencode-ai/ui/v2/styles/tailwind.css"],
  "src/styles.ts": ["@opencode-ai/ui/v2/menu-v2.css", "@opencode-ai/ui/v2/select-v2.css", "@opencode-ai/ui/v2/tooltip-v2.css"],
}
const styleImport = /@import\s+(?:url\()?["']([^"']+)["']/g

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const resolve = createResolver(compilerOptions())
  const codeFiles = listFiles(root, ["src", "e2e", "plugins"], codeExtensions)
  const styleFiles = listFiles(root, ["src", "plugins"], styleExtensions)
  const violations: Violation[] = []
  for (const file of codeFiles) violations.push(...kitImports(root, readSource(file), resolve))
  for (const file of styleFiles) violations.push(...kitStyleImports(root, file, readFileSync(file, "utf8"), resolve))
  finish("v2-only", root, violations, codeFiles.length + styleFiles.length)
}

function kitImports(root: string, { file, sf }: Source, resolve: Resolver): Violation[] {
  const listed = kitStylesheets[rel(root, file)] ?? []
  const violations: Violation[] = []
  for (const { specifier, node } of importsOf(sf)) {
    if (listed.includes(specifier)) continue
    const reason = outsideDoor(root, file, specifier, resolve(file, specifier))
    if (reason) violations.push({ file, line: startLine(node, sf), message: reason })
  }
  return violations
}

function kitStyleImports(root: string, file: string, text: string, resolve: Resolver): Violation[] {
  const listed = kitStylesheets[rel(root, file)] ?? []
  const violations: Violation[] = []
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(styleImport)) {
      const specifier = match[1] ?? ""
      if (listed.includes(specifier)) continue
      const target = specifier.startsWith(".") ? realPath(resolvePath(dirname(file), specifier)) : resolve(file, specifier)
      const reason = outsideDoor(root, file, specifier, target)
      if (reason) violations.push({ file, line: index + 1, message: reason })
    }
  })
  return violations
}

function realPath(path: string): string | undefined {
  return existsSync(path) ? realpathSync(path) : undefined
}

function outsideDoor(root: string, file: string, specifier: string, target: string | undefined): string | undefined {
  if (target && under(root, target, "src/legacy")) return `imports the old app (${rel(root, target)}); v2 code imports only v2 code`
  if (specifier.startsWith("@opencode-ai/session-ui") || (target && under(repoRoot, target, sessionKit)))
    return `imports ${sessionKit} through ${specifier}; v2's copies of it live in src/transcript`
  if (under(root, file, kitDoor)) return undefined
  if (specifier.startsWith("@opencode-ai/")) return `imports the kit ${specifier} outside src/ui; import it from @/ui`
  const kit = target ? kitFolders.find((folder) => under(repoRoot, target, folder)) : undefined
  return kit ? `imports ${kit} through ${specifier} outside src/ui; import it from @/ui` : undefined
}

main()
