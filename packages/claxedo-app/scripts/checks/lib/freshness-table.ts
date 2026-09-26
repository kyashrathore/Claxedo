import { join } from "node:path"
import { readSource, startLine, ts } from "./parse"
import { literalText, unwrap, walk } from "./tree"

export const freshnessPath = "src/server/freshness.ts"

export type FreshnessEntry = {
  readonly name: string
  readonly line: number
  readonly kind: string | undefined
  readonly ms: number | undefined
  readonly reason: string | undefined
  readonly events: readonly string[] | undefined
}

export type FreshnessTable = { readonly file: string; readonly entries: readonly FreshnessEntry[] }

export function readFreshnessTable(root: string): FreshnessTable {
  const file = join(root, freshnessPath)
  const { sf } = readSource(file)
  const table = topLevelInitializer(sf, "freshness")
  if (!table || !ts.isObjectLiteralExpression(table)) throw new Error(`${file}: no exported freshness object literal`)
  const entries = table.properties.map((property) => entryOf(sf, property))
  return { file, entries }
}

function entryOf(sf: ts.SourceFile, property: ts.ObjectLiteralElementLike): FreshnessEntry {
  const line = startLine(property, sf)
  const name = property.name && ts.isIdentifier(property.name) ? property.name.text : property.getText(sf)
  const value = ts.isPropertyAssignment(property) ? resolve(sf, property.initializer) : ts.isShorthandPropertyAssignment(property) ? topLevelInitializer(sf, name) : undefined
  if (!value || !ts.isObjectLiteralExpression(value)) return { name, line, kind: undefined, ms: undefined, reason: undefined, events: undefined }
  const field = (key: string) => {
    const member = value.properties.find((item) => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === key)
    return member && ts.isPropertyAssignment(member) ? resolve(sf, member.initializer) : undefined
  }
  const kind = field("kind")
  const ms = field("ms")
  const reason = field("reason")
  const events = field("events")
  return {
    name,
    line,
    kind: kind ? literalText(kind) : undefined,
    ms: ms ? numberOf(ms) : undefined,
    reason: reason ? literalText(reason) : undefined,
    events: events && ts.isArrayLiteralExpression(events) ? events.elements.map((element) => literalText(unwrap(element)) ?? element.getText(sf)) : undefined,
  }
}

function resolve(sf: ts.SourceFile, expression: ts.Expression): ts.Expression | undefined {
  const value = unwrap(expression)
  return ts.isIdentifier(value) ? topLevelInitializer(sf, value.text) : value
}

function topLevelInitializer(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined
  walk(sf, (node) => {
    if (found || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name || !node.initializer) return
    if (ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)) found = unwrap(node.initializer)
  })
  return found
}

function numberOf(expression: ts.Expression): number | undefined {
  const value = unwrap(expression)
  if (ts.isNumericLiteral(value)) return Number(value.text.replace(/_/g, ""))
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken) {
    const inner = numberOf(value.operand)
    return inner === undefined ? undefined : -inner
  }
  if (!ts.isBinaryExpression(value)) return undefined
  const left = numberOf(value.left)
  const right = numberOf(value.right)
  if (left === undefined || right === undefined) return undefined
  if (value.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right
  if (value.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right
  return undefined
}
