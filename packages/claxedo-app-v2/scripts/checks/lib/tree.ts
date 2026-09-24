import { ts } from "./parse"

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

export type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

export function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  )
}

export function functionName(node: FunctionNode): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor"
  if (node.name && ts.isIdentifier(node.name)) return node.name.text
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isBinaryExpression(parent) && ts.isPropertyAccessExpression(parent.left)) return parent.left.name.text
  return undefined
}

export function enclosingFunction(node: ts.Node): FunctionNode | undefined {
  let current = node.parent
  while (current) {
    if (isFunctionNode(current)) return current
    current = current.parent
  }
  return undefined
}

export function containsJsx(node: ts.Node): boolean {
  let found = false
  walk(node, (child) => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) found = true
  })
  return found
}

export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

export function literalText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined
}

export function templateText(node: ts.TemplateExpression): string {
  return node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join("")
}

export function textOf(node: ts.Node): string | undefined {
  if (ts.isTemplateExpression(node)) return templateText(node)
  return literalText(node)
}

export function calleeName(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression)
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return undefined
}

export function isTopLevel(node: ts.Node): boolean {
  return ts.isSourceFile(node.parent)
}

export function identifierIn(node: ts.Node, names: ReadonlySet<string>): ts.Identifier | undefined {
  let found: ts.Identifier | undefined
  walk(node, (child) => {
    if (!found && ts.isIdentifier(child) && names.has(child.text)) found = child
  })
  return found
}

export function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}
