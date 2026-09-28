import { codeExtensions, listFiles, parseArgs, under } from "./lib/files"
import { compilerOptions, createResolver, importsOf, readSource, startLine } from "./lib/parse"
import { finish, type Violation } from "./lib/report"

const wireSpecifier = /(^|\/)server\/wire(\/|$)/

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const resolve = createResolver(compilerOptions())
  const files = listFiles(root, ["src", "e2e"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    if (under(root, file, "src/server")) continue
    const { sf } = readSource(file)
    for (const { specifier, node } of importsOf(sf)) {
      const target = resolve(file, specifier)
      const reaches = target ? under(root, target, "src/server/wire") : wireSpecifier.test(specifier)
      if (!reaches) continue
      violations.push({
        file,
        line: startLine(node, sf),
        message: `imports src/server/wire (${specifier}); only src/server reads the wire`,
      })
    }
  }
  finish("adapter-boundary", root, violations, files.length)
}

main()
