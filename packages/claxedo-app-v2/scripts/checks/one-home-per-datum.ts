import { codeExtensions, listFiles, parseArgs, under } from "./lib/files"
import { importsOf, readSource, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { calleeName, isTopLevel, literalText, unwrap, walk } from "./lib/tree"

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

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const files = listFiles(root, ["src", "plugins"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    const { sf } = readSource(file)
    const inServer = under(root, file, "src/server")
    for (const { specifier, node } of importsOf(sf)) {
      if (!retiredPackages.some((pattern) => pattern.test(specifier))) continue
      violations.push({ file, line: startLine(node, sf), message: `imports ${specifier}; pushed data lives in the domain's Solid store` })
    }
    walk(sf, (node) => {
      for (const message of [cacheWrite(node, inServer), queryKey(node, inServer), moduleState(node)]) {
        if (message) violations.push({ file, line: startLine(node, sf), message })
      }
    })
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

function moduleState(node: ts.Node): string | undefined {
  if (!ts.isVariableStatement(node) || !isTopLevel(node)) return undefined
  const mutable = (node.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using)) === 0
  if (mutable) return "module-level let or var; state lives in a store owned by a provider"
  for (const declaration of node.declarationList.declarations) {
    const reason = declaration.initializer ? mutableInitializer(unwrap(declaration.initializer)) : undefined
    if (reason) return reason
  }
  return undefined
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
