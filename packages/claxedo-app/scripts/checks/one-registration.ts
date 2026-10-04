import { codeExtensions, listFiles, packageRoot, rel } from "./lib/files"
import { compilerOptions, createProgram, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { walk } from "./lib/tree"

type Registration = { readonly file: string; readonly line: number; readonly owner: ts.Node }

function main(): never {
  const files = listFiles(packageRoot, ["src"], codeExtensions).filter((file) => !/\.test\.tsx?$/.test(file))
  const program = createProgram(files, compilerOptions())
  const checker = program.getTypeChecker()
  const keys = new Map<string, Registration[]>()
  const commands = new Map<string, Registration[]>()
  for (const file of files) {
    const sf = program.getSourceFile(file)
    if (!sf) continue
    walk(sf, (node) => {
      if (ts.isCallExpression(node)) recordDictionary(node, checker, keys)
      if (ts.isObjectLiteralExpression(node)) recordCommand(node, sf, checker, commands)
    })
  }
  const violations = [
    ...duplicates(packageRoot, keys, (key, other) => `i18n key "${key}" is also defined by the dictionary in ${other}; one owner per key`),
    ...duplicates(packageRoot, commands, (id, other) => `command id "${id}" is also registered in ${other}; one owner per command`),
  ]
  finish("one-registration", packageRoot, violations, files.length)
}

function recordDictionary(node: ts.CallExpression, checker: ts.TypeChecker, keys: Map<string, Registration[]>): void {
  const parameter = checker.getResolvedSignature(node)?.parameters[0]?.valueDeclaration
  if (!parameter || !ts.isParameter(parameter) || !parameter.type || !/^Translations\b/.test(parameter.type.getText())) return
  const argument = node.arguments[0]
  if (!argument) return
  const en = checker.getTypeAtLocation(argument).getProperty("en")
  if (!en) return
  const owner = declarationOf(argument, checker) ?? argument
  for (const property of checker.getTypeOfSymbolAtLocation(en, argument).getProperties()) {
    add(keys, property.name, { file: owner.getSourceFile().fileName, line: startLine(owner, owner.getSourceFile()), owner })
  }
}

function declarationOf(node: ts.Expression, checker: ts.TypeChecker): ts.Node | undefined {
  const symbol = checker.getSymbolAtLocation(node)
  if (!symbol) return undefined
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  return target.valueDeclaration ?? target.declarations?.[0]
}

function recordCommand(node: ts.ObjectLiteralExpression, sf: ts.SourceFile, checker: ts.TypeChecker, commands: Map<string, Registration[]>): void {
  const contextual = checker.getContextualType(node)
  if (!contextual || checker.typeToString(contextual) !== "CommandOption") return
  const id = node.properties.find((property) => property.name?.getText(sf) === "id")
  if (!id || !ts.isPropertyAssignment(id)) return
  const type = checker.getTypeAtLocation(id.initializer)
  if (!type.isStringLiteral()) return
  add(commands, type.value, { file: sf.fileName, line: startLine(id, sf), owner: node })
}

function add(map: Map<string, Registration[]>, name: string, registration: Registration): void {
  const existing = map.get(name) ?? []
  if (existing.some((item) => item.owner === registration.owner)) return
  map.set(name, [...existing, registration])
}

function duplicates(root: string, map: ReadonlyMap<string, readonly Registration[]>, message: (name: string, other: string) => string): Violation[] {
  const violations: Violation[] = []
  for (const [name, items] of map) {
    if (items.length < 2) continue
    for (const item of items) {
      const other = items.find((candidate) => candidate !== item)
      if (other) violations.push({ file: item.file, line: item.line, message: message(name, `${rel(root, other.file)}:${other.line}`) })
    }
  }
  return violations
}

main()
