import { codeExtensions, listFiles, parseArgs, under } from "./lib/files"
import { readSource, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { calleeName, literalText, unwrap, walk } from "./lib/tree"

const roles = new Set(["owner", "admin", "member"])
const rankNames = new Set(["rank", "role", "orgRole", "roleRank"])
const shareFlags = new Set(["can_manage_shares", "canManageShares"])
const equality = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])
const ordering = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
])
const guidance = "ask can() in src/access, which answers from server facts"

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const files = listFiles(root, ["src"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    if (under(root, file, "src/access")) continue
    const { sf } = readSource(file)
    const wire = under(root, file, "src/server/wire")
    walk(sf, (node) => {
      const message = accessRule(node, wire)
      if (message) violations.push({ file, line: startLine(node, sf), message })
    })
  }
  finish("access-boundary", root, violations, files.length)
}

function accessRule(node: ts.Node, wire: boolean): string | undefined {
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind
    if (equality.has(kind) && (isRole(node.left) || isRole(node.right))) return `compares a role name; ${guidance}`
    if (ordering.has(kind) && (isRank(node.left) || isRank(node.right))) return `compares a rank; ${guidance}`
    return undefined
  }
  if (ts.isCaseClause(node)) return isRole(node.expression) ? `switches on a role name; ${guidance}` : undefined
  if (ts.isCallExpression(node)) return roleMembership(node)
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === "prompt" && lastName(node.expression) === "capabilities") return `reads capabilities.prompt; ${guidance}`
    if (shareFlags.has(node.name.text) && !(wire && node.name.text === "can_manage_shares")) return `reads ${node.name.text}; ${guidance}`
  }
  return undefined
}

function roleMembership(call: ts.CallExpression): string | undefined {
  if (calleeName(call) !== "includes") return undefined
  const callee = unwrap(call.expression)
  const receiver = ts.isPropertyAccessExpression(callee) ? unwrap(callee.expression) : undefined
  const [argument] = call.arguments
  const listed = receiver !== undefined && ts.isArrayLiteralExpression(receiver) && receiver.elements.some(isRole)
  return (argument !== undefined && isRole(argument)) || listed ? `tests membership in a role list; ${guidance}` : undefined
}

function isRole(expression: ts.Expression): boolean {
  const text = literalText(unwrap(expression))
  return text !== undefined && roles.has(text)
}

function isRank(expression: ts.Expression): boolean {
  const name = lastName(expression)
  return name !== undefined && rankNames.has(name)
}

function lastName(expression: ts.Expression): string | undefined {
  const target = unwrap(expression)
  if (ts.isIdentifier(target)) return target.text
  if (ts.isPropertyAccessExpression(target)) return target.name.text
  return undefined
}

main()
