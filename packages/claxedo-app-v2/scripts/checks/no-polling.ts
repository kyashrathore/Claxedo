import { codeExtensions, listFiles, parseArgs, rel } from "./lib/files"
import { readSource, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { enclosingFunction, functionName, unwrap, walk } from "./lib/tree"

const timerOwners: Readonly<Record<string, string>> = {
  "src/lib/age-clock.ts": "the app's one age clock: one timeout at the next instant a visible age label changes, none while the page is hidden",
  "src/lib/second-ticker.ts": "the clock's ref-counted 1 s tick, running only while a running tool's elapsed time or a retry countdown reads it",
}
const pacingOwners: Readonly<Record<string, string>> = {
  "src/transcript/message-part.tsx": "paced reveal of streamed text more than 512 chars behind, in 24 ms steps, as today; exp-stream owns any change to it",
  "src/terminal/backend/clipboard.ts": "paced write of a paste over 16,384 chars to the PTY in 4,096-char chunks every 5 ms, as v1",
  "src/server/workspace-start.ts": "an explicit cloud workspace start's provisioning poll: each wait is the server's retryAfterMs clamped to 0.5–30 s, at most 30 attempts, as v1",
}
const timers = new Set(["setInterval", "setTimeout"])
const globals = new Set(["window", "globalThis", "self"])
const intervalOptions = new Set(["refetchInterval", "refetchIntervalInBackground"])

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const files = listFiles(root, ["src", "plugins"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    const { sf } = readSource(file)
    const path = rel(root, file)
    const owner = path in timerOwners
    const paces = owner || path in pacingOwners
    walk(sf, (node) => {
      const message = polling(node, owner, paces)
      if (message) violations.push({ file, line: startLine(node, sf), message })
    })
  }
  finish("no-polling", root, violations, files.length)
}

function polling(node: ts.Node, owner: boolean, paces: boolean): string | undefined {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && intervalOptions.has(node.name.text)) {
    return `${node.name.text} polls; events invalidate the query instead`
  }
  if (!ts.isCallExpression(node)) return undefined
  const timer = timerName(node)
  if (timer === "setInterval" && !owner) return "setInterval polls; wait for the server's event, or read the clock in src/lib/clock.tsx"
  if (timer === "setTimeout" && !paces && loops(node)) {
    return "setTimeout loop polls; only the named timer and pacing owners in no-polling.ts re-arm a timer"
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
