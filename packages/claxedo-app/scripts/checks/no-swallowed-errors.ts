import { codeExtensions, listFiles, parseArgs, rel } from "./lib/files"
import { readSource, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { calleeName, unwrap, walk } from "./lib/tree"

const textMethods = new Set(["includes", "startsWith", "endsWith", "match", "search", "indexOf", "test"])
const equality = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])
const textMatch = "matches on error message text; classify the error in src/server/errors.ts"
const silentCatch = "catch swallows the error; make it a machine state or log it with context"
const silentHandler = ".catch handler ignores the error; make it a machine state or log it with context"

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const files = listFiles(root, ["src"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    const { sf } = readSource(file)
    const classifier = rel(root, file) === "src/server/errors.ts"
    walk(sf, (node) => {
      const message = swallowed(node) ?? (classifier ? undefined : messageMatch(node))
      if (message) violations.push({ file, line: startLine(node, sf), message })
    })
  }
  finish("no-swallowed-errors", root, violations, files.length)
}

function swallowed(node: ts.Node): string | undefined {
  if (ts.isCatchClause(node)) return isSilentBlock(node.block) ? silentCatch : undefined
  if (!ts.isCallExpression(node) || calleeName(node) !== "catch") return undefined
  if (!ts.isPropertyAccessExpression(unwrap(node.expression))) return undefined
  const [handler] = node.arguments
  if (!handler) return ".catch() without a handler swallows the rejection"
  const fn = unwrap(handler)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined
  if (fn.parameters.length === 0) return silentHandler
  const silent = ts.isBlock(fn.body) ? isSilentBlock(fn.body) : !hasEffect(fn.body)
  return silent ? silentHandler : undefined
}

function isSilentBlock(block: ts.Block): boolean {
  if (block.statements.length === 0) return true
  return block.statements.every(
    (statement) => ts.isReturnStatement(statement) && (!statement.expression || !hasEffect(statement.expression)),
  )
}

function hasEffect(node: ts.Node): boolean {
  let found = false
  walk(node, (child) => {
    if (ts.isCallExpression(child) || ts.isNewExpression(child) || ts.isThrowStatement(child) || ts.isAwaitExpression(child)) {
      found = true
    }
  })
  return found
}

function messageMatch(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression)
    if (!ts.isPropertyAccessExpression(callee) || !textMethods.has(callee.name.text)) return undefined
    if (readsMessage(callee.expression) || isStringified(callee.expression)) return textMatch
    const [argument] = node.arguments
    return callee.name.text === "test" && argument && readsMessage(argument) ? textMatch : undefined
  }
  if (ts.isBinaryExpression(node) && equality.has(node.operatorToken.kind)) {
    return readsMessage(node.left) || readsMessage(node.right) ? textMatch : undefined
  }
  if (ts.isSwitchStatement(node)) return readsMessage(node.expression) ? textMatch : undefined
  return undefined
}

function readsMessage(expression: ts.Expression): boolean {
  const target = unwrap(expression)
  return ts.isPropertyAccessExpression(target) && target.name.text === "message"
}

function isStringified(expression: ts.Expression): boolean {
  const target = unwrap(expression)
  return ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === "String"
}

main()
