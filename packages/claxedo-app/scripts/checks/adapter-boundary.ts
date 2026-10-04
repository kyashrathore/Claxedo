import { codeExtensions, listFiles, packageRoot, under } from "./lib/files"
import { compilerOptions, createResolver, importsOf, readSource, startLine } from "./lib/parse"
import { finish, type Violation } from "./lib/report"

const wireSpecifier = /(^|\/)server\/wire(\/|$)/

function main(): never {
  const resolve = createResolver(compilerOptions())
  const files = listFiles(packageRoot, ["src", "e2e"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    if (under(packageRoot, file, "src/server")) continue
    const { sf } = readSource(file)
    for (const { specifier, node } of importsOf(sf)) {
      const target = resolve(file, specifier)
      const reaches = target ? under(packageRoot, target, "src/server/wire") : wireSpecifier.test(specifier)
      if (!reaches) continue
      violations.push({
        file,
        line: startLine(node, sf),
        message: `imports src/server/wire (${specifier}); only src/server reads the wire`,
      })
    }
  }
  finish("adapter-boundary", packageRoot, violations, files.length)
}

main()
