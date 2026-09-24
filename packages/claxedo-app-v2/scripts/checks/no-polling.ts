import { codeExtensions, listFiles, parseArgs, rel } from "./lib/files"
import { readSource, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { enclosingFunction, functionName, unwrap, walk } from "./lib/tree"

const timerOwners = ["src/server/transport.ts", "src/server/status.ts"]
const timers = new Set(["setInterval", "setTimeout"])
const globals = new Set(["window", "globalThis", "self"])
const intervalOptions = new Set(["refetchInterval", "refetchIntervalInBackground"])

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const files = listFiles(root, ["src", "plugins"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    const { sf } = readSource(file)
    const owner = timerOwners.includes(rel(root, file))
    walk(sf, (node) => {
      const message = polling(node, owner)
      if (message) violations.push({ file, line: startLine(node, sf), message })
    })
  }
  finish("no-polling", root, violations, files.length)
}

function polling(node: ts.Node, owner: boolean): string | undefined {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && intervalOptions.has(node.name.text)) {
    return `${node.name.text} polls; events invalidate the query instead`
  }
  if (!ts.isCallExpression(node)) return undefined
  const timer = timerName(node)
  if (timer === "setInterval") return "setInterval polls; wait for the server's event instead"
  if (timer === "setTimeout" && !owner && loops(node)) {
    return "setTimeout loop polls; only src/server/transport.ts re-arms a timer (and status.ts if P0.7 requires it)"
  }
  return undefined
}

function timerName(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression)
  if (ts.isIdentifier(callee) && timers.has(callee.text)) return callee.text
  if (!ts.isPropertyAccessExpression(callee) || !timers.has(callee.name.text)) return undefined
  return ts.isIdentifier(callee.expression) && globals.has(callee.expression.text) ? callee.name.text : undefined
}

function loops(call: ts.CallExpression): boolean {
  if (insideLoop(call)) return true
  const enclosing = enclosingFunction(call)
  const name = enclosing ? functionName(enclosing) : undefined
  const [callback] = call.arguments
  if (!name || !callback) return false
  const target = unwrap(callback)
  if (ts.isIdentifier(target) && target.text === name) return true
  return callsNamed(target, name)
}

function insideLoop(node: ts.Node): boolean {
  let current = node.parent
  while (current) {
    if (ts.isIterationStatement(current, false)) return true
    current = current.parent
  }
  return false
}

function callsNamed(node: ts.Node, name: string): boolean {
  let found = false
  walk(node, (child) => {
    if (!ts.isCallExpression(child)) return
    const callee = unwrap(child.expression)
    if (ts.isIdentifier(callee) && callee.text === name) found = true
  })
  return found
}

main()
