import { readFileSync } from "node:fs"
import { moduleStateExceptions } from "./data/module-state-exceptions"
import { codeExtensions, listFiles, parseArgs, rel, under } from "./lib/files"
import { importsOf, readSource, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { calleeName, hasExportModifier, isTopLevel, literalText, unwrap, walk } from "./lib/tree"

const pushedData = new Set([
  "session",
  "sessions",
  "transcript",
  "message",
  "messages",
  "part",
  "parts",
  "status",
  "statuses",
  "request",
  "requests",
  "permission",
  "permissions",
  "question",
  "questions",
  "todo",
  "todos",
])
const namespaces = new Set(["claxedo", "app"])
const retiredPackages = [/^@tanstack\/ai(-|\/|$)/, /^@solid-primitives\/event-bus(\/|$)/]
const cacheWriters = new Set(["setQueryData", "setQueriesData"])
const mutableContainers = new Set(["Map", "Set", "WeakMap", "WeakSet"])
const stateFactories = new Set(["createSignal", "createStore", "createMutable", "createResource"])
const mutators = ["add", "set", "delete", "clear"]

type ModuleState = { readonly binding: string; readonly message: string }

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const files = listFiles(root, ["src", "plugins"], codeExtensions)
  const violations: Violation[] = []
  const used = new Set<string>()
  const mutatedExports = exportedMutations(files)
  for (const file of files) {
    const { sf } = readSource(file)
    const inServer = under(root, file, "src/server")
    for (const { specifier, node } of importsOf(sf)) {
      if (!retiredPackages.some((pattern) => pattern.test(specifier))) continue
      violations.push({ file, line: startLine(node, sf), message: `imports ${specifier}; pushed data lives in the domain's Solid store` })
    }
    walk(sf, (node) => {
      for (const message of [cacheWrite(node, inServer), queryKey(node, inServer)]) {
        if (message) violations.push({ file, line: startLine(node, sf), message })
      }
      for (const state of moduleState(node, sf, mutatedExports)) {
        const exception = namedException(rel(root, file), state.binding)
        if (exception) used.add(exception)
        else violations.push({ file, line: startLine(node, sf), message: state.message })
      }
    })
  }
  for (const { file, binding } of moduleStateExceptions) {
    if (!used.has(`${file}#${binding}`)) violations.push({ file, line: 1, message: `named module-state exception ${binding} matches nothing; remove it from data/module-state-exceptions.ts` })
  }
  finish("one-home-per-datum", root, violations, files.length)
}

function cacheWrite(node: ts.Node, inServer: boolean): string | undefined {
  if (inServer || !ts.isCallExpression(node)) return undefined
  const name = calleeName(node)
  return name && cacheWriters.has(name) ? `${name} outside src/server; only a mutation's own result is written there` : undefined
}

function queryKey(node: ts.Node, inServer: boolean): string | undefined {
  if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || node.name.text !== "queryKey") return undefined
  const initializer = unwrap(node.initializer)
  if (!ts.isArrayLiteralExpression(initializer)) return undefined
  if (!inServer) return "literal query key outside src/server; use the query options exported by src/server"
  const subject = keySubject(initializer)
  return subject && pushedData.has(subject) ? `query for pushed data (${subject}); it lives in the domain's Solid store` : undefined
}

function keySubject(array: ts.ArrayLiteralExpression): string | undefined {
  for (const element of array.elements) {
    const text = literalText(unwrap(element))
    if (text === undefined) return undefined
    if (!namespaces.has(text.toLowerCase())) return text.toLowerCase()
  }
  return undefined
}

function namedException(file: string, binding: string): string | undefined {
  const hit = moduleStateExceptions.find((exception) => exception.file === file && exception.binding === binding)
  return hit ? `${hit.file}#${hit.binding}` : undefined
}

function moduleState(node: ts.Node, sf: ts.SourceFile, mutatedExports: ReadonlySet<string>): ModuleState[] {
  if (!ts.isVariableStatement(node) || !isTopLevel(node)) return []
  const mutable = (node.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using)) === 0
  const states: ModuleState[] = []
  for (const declaration of node.declarationList.declarations) {
    const binding = ts.isIdentifier(declaration.name) ? declaration.name.text : declaration.name.getText(sf)
    if (mutable) {
      states.push({ binding, message: "module-level let or var; state lives in a store owned by a provider" })
      continue
    }
    const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined
    if (!initializer) continue
    const exported = hasExportModifier(node)
    if (isConstantCollection(initializer) && !mutatedIn(sf, binding) && !(exported && mutatedExports.has(binding))) continue
    const message = mutableInitializer(initializer)
    if (message) states.push({ binding, message })
  }
  return states
}

function isConstantCollection(expression: ts.Expression): boolean {
  if (!ts.isNewExpression(expression) || !ts.isIdentifier(expression.expression)) return false
  if (expression.expression.text !== "Set" && expression.expression.text !== "Map") return false
  const args = expression.arguments ?? []
  return args.length === 0 || (args.length === 1 && ts.isArrayLiteralExpression(unwrap(args[0]!)))
}

function mutatedIn(sf: ts.SourceFile, binding: string): boolean {
  let mutated = false
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
    const target = unwrap(node.expression.expression)
    if (ts.isIdentifier(target) && target.text === binding && mutators.includes(node.expression.name.text)) mutated = true
  })
  return mutated
}

function exportedMutations(files: readonly string[]): Set<string> {
  const pattern = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\??\\.\\s*(${mutators.join("|")})\\s*\\(`, "g")
  const names = new Set<string>()
  for (const file of files) for (const match of readFileSync(file, "utf8").matchAll(pattern)) if (match[1]) names.add(match[1])
  return names
}

function mutableInitializer(expression: ts.Expression): string | undefined {
  if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && mutableContainers.has(expression.expression.text)) {
    return `module-level ${expression.expression.text}; a cache lives in a store owned by a provider, with a size cap`
  }
  if (ts.isCallExpression(expression)) {
    const name = calleeName(expression)
    if (name && stateFactories.has(name)) return `module-level ${name}; state lives in a store owned by a provider`
  }
  return undefined
}

main()
