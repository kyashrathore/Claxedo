import path from "node:path"
import { mkdir, unlink } from "node:fs/promises"
import ts from "../../../node_modules/.bun/typescript@5.9.3/node_modules/typescript/lib/typescript.js"

type AsarNode = {
  files?: Record<string, AsarNode>
  offset?: string
  size?: number
}

type SvgElement = {
  tag: string
  attributes: Array<[string, string]>
  children: SvgElement[]
  unresolved: number
}

const sourcePath = process.argv[2] ?? "/Applications/ChatGPT.app/Contents/Resources/app.asar"
const outputDirectory = path.resolve(import.meta.dir, "../src/assets/icons/codex")
const source = new Uint8Array(await Bun.file(sourcePath).arrayBuffer())
const view = new DataView(source.buffer, source.byteOffset, source.byteLength)
const headerSize = view.getUint32(12, true)
const header = JSON.parse(new TextDecoder().decode(source.subarray(16, 16 + headerSize))) as AsarNode
const dataOffset = (16 + headerSize + 3) & ~3
const rendererAsset = findRendererAsset(header)
const renderer = readAsarFile(rendererAsset.node)
const sourceFile = ts.createSourceFile(rendererAsset.path, renderer, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const candidates: Array<{ element: SvgElement; offset: number; sourceSymbol: string | null }> = []
const resolving = new Set<string>()

visit(sourceFile)

await prepareOutputDirectory()

const hashes = new Map<string, string>()
const icons = candidates.map((candidate, index) => {
  const id = `codex-20-${String(index + 1).padStart(3, "0")}`
  const file = `${id}.svg`
  const svg = `${render(candidate.element)}\n`
  const hash = new Bun.CryptoHasher("sha256").update(svg).digest("hex").slice(0, 12)
  const duplicateOf = hashes.get(hash) ?? null
  hashes.set(hash, duplicateOf ?? id)
  return {
    id,
    file,
    hash,
    duplicateOf,
    sourceOffset: candidate.offset,
    sourceSymbol: candidate.sourceSymbol,
    unresolvedValues: candidate.element.unresolved,
    svg,
    element: candidate.element,
  }
})

await Promise.all(icons.map((icon) => Bun.write(path.join(outputDirectory, icon.file), icon.svg)))
await Bun.write(
  path.join(outputDirectory, "sprite.svg"),
  [
    `<svg xmlns="http://www.w3.org/2000/svg">`,
    ...icons.map(
      (icon) =>
        `  <symbol id="${icon.id}"${symbolAttributes(icon.element)}>${icon.element.children.map(render).join("")}</symbol>`,
    ),
    `</svg>`,
    ``,
  ].join("\n"),
)
await Bun.write(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(
    {
      source: sourcePath,
      rendererAsset: rendererAsset.path,
      canvas: "20x20",
      sourceCount: icons.length,
      uniqueGeometryCount: new Set(icons.map((icon) => icon.hash)).size,
      unresolvedValueCount: icons.reduce((total, icon) => total + icon.unresolvedValues, 0),
      icons: icons.map(({ svg: _svg, element: _element, ...icon }) => icon),
    },
    null,
    2,
  )}\n`,
)

console.log(
  `Extracted ${icons.length} Codex 20x20 SVG components (${new Set(icons.map((icon) => icon.hash)).size} unique) to ${outputDirectory}`,
)

function visit(node: ts.Node) {
  if (ts.isCallExpression(node)) {
    const element = parseElement(node)
    if (element?.tag === "svg" && attribute(element, "viewBox") === "0 0 20 20") {
      candidates.push({
        element,
        offset: node.getStart(sourceFile),
        sourceSymbol: findSourceSymbol(node),
      })
    }
  }
  ts.forEachChild(node, visit)
}

function parseElement(expression: ts.Expression): SvgElement | null {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) {
    const key = `${value.getStart(sourceFile)}:${value.text}`
    if (resolving.has(key)) return null
    resolving.add(key)
    const result = findAssignments(value).reduce<SvgElement | null>(
      (resolved, assignment) => resolved ?? parseElement(assignment),
      null,
    )
    resolving.delete(key)
    return result
  }
  if (!ts.isCallExpression(value) || value.arguments.length < 2) return null

  const tagArgument = value.arguments[0]
  const propsArgument = value.arguments[1]
  if (!ts.isExpression(tagArgument) || !ts.isExpression(propsArgument)) return null

  const tag = literal(tagArgument)
  const props = unwrap(propsArgument)
  if (tag == null || !ts.isObjectLiteralExpression(props)) return null

  const attributes: Array<[string, string]> = []
  const children: SvgElement[] = []
  let unresolved = 0

  props.properties.forEach((property) => {
    if (ts.isSpreadAssignment(property)) return
    if (!ts.isPropertyAssignment(property)) {
      unresolved++
      return
    }

    const name = propertyName(property.name)
    if (name === "children") {
      const parsed = parseChildren(property.initializer)
      children.push(...parsed.children)
      unresolved += parsed.unresolved
      return
    }
    if (name === "key" || name.startsWith("on")) return

    const result = literal(property.initializer)
    if (result == null) {
      if (name === "className") return
      unresolved++
      return
    }
    attributes.push([attributeName(name), result])
  })

  return {
    tag,
    attributes,
    children,
    unresolved: unresolved + children.reduce((total, child) => total + child.unresolved, 0),
  }
}

function parseChildren(expression: ts.Expression) {
  const value = unwrap(expression)
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.reduce(
      (result, child) => {
        if (!ts.isExpression(child)) return { ...result, unresolved: result.unresolved + 1 }
        const parsed = parseElement(child)
        if (parsed == null) return isNullLike(child) ? result : { ...result, unresolved: result.unresolved + 1 }
        return { children: [...result.children, parsed], unresolved: result.unresolved }
      },
      { children: [] as SvgElement[], unresolved: 0 },
    )
  }

  const child = parseElement(value)
  if (child != null) return { children: [child], unresolved: 0 }
  return { children: [], unresolved: isNullLike(value) ? 0 : 1 }
}

function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) return unwrap(expression.expression)
  if (ts.isAsExpression(expression)) return unwrap(expression.expression)
  if (ts.isNonNullExpression(expression)) return unwrap(expression.expression)
  return expression
}

function literal(node: ts.Node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true"
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false"
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return `${node.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${node.operand.text}`
  }
  return null
}

function isNullLike(node: ts.Node) {
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === "undefined")
}

function propertyName(node: ts.PropertyName) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return node.getText(sourceFile)
}

function attributeName(name: string) {
  if (name === "className") return "class"
  if (
    name === "viewBox" ||
    name === "preserveAspectRatio" ||
    name === "gradientUnits" ||
    name === "gradientTransform" ||
    name === "patternUnits" ||
    name === "patternContentUnits" ||
    name === "markerWidth" ||
    name === "markerHeight" ||
    name === "refX" ||
    name === "refY"
  )
    return name
  if (name === "xmlnsXlink") return "xmlns:xlink"
  if (name === "xlinkHref") return "xlink:href"
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
}

function attribute(element: SvgElement, name: string) {
  return element.attributes.find(([key]) => key === name)?.[1] ?? null
}

function symbolAttributes(element: SvgElement) {
  return element.attributes
    .filter(([name]) => name !== "xmlns" && name !== "width" && name !== "height")
    .map(([name, value]) => ` ${name}="${escape(value)}"`)
    .join("")
}

function render(element: SvgElement): string {
  const attributes = element.attributes.map(([name, value]) => ` ${name}="${escape(value)}"`).join("")
  if (element.children.length === 0) return `<${element.tag}${attributes}/>`
  return `<${element.tag}${attributes}>${element.children.map(render).join("")}</${element.tag}>`
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function findSourceSymbol(node: ts.Node) {
  let current: ts.Node | undefined = node
  while (current != null) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return parent.left.getText(sourceFile)
      }
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    }
    current = current.parent
  }
  return null
}

function findAssignments(identifier: ts.Identifier) {
  let scope: ts.Node = identifier
  while (scope.parent != null && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent

  const assignments: Array<{ expression: ts.Expression; position: number }> = []
  const collect = (node: ts.Node) => {
    if (node !== scope && ts.isFunctionLike(node)) return
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === identifier.text &&
      node.getStart(sourceFile) < identifier.getStart(sourceFile)
    ) {
      assignments.push({ expression: node.right, position: node.getStart(sourceFile) })
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier.text &&
      node.initializer != null &&
      node.getStart(sourceFile) < identifier.getStart(sourceFile)
    ) {
      assignments.push({ expression: node.initializer, position: node.getStart(sourceFile) })
    }
    ts.forEachChild(node, collect)
  }
  collect(scope)
  return assignments.sort((left, right) => right.position - left.position).map((assignment) => assignment.expression)
}

function findRendererAsset(root: AsarNode) {
  const assets = root.files?.webview?.files?.assets
  const entry = Object.entries(assets?.files ?? {}).find(([name]) => /^app-initial-.*\.js$/.test(name))
  if (entry == null) throw new Error("Could not find the Codex renderer asset in app.asar")
  return { path: `webview/assets/${entry[0]}`, node: entry[1] }
}

function readAsarFile(node: AsarNode) {
  if (node.offset == null || node.size == null) throw new Error("Invalid ASAR file entry")
  return new TextDecoder().decode(source.subarray(dataOffset + Number(node.offset), dataOffset + Number(node.offset) + node.size))
}

async function prepareOutputDirectory() {
  await mkdir(outputDirectory, { recursive: true })
  const generated = [...new Bun.Glob("codex-20-*.svg").scanSync(outputDirectory), "manifest.json", "sprite.svg"]
  await Promise.all(
    generated.map((file) =>
      Bun.file(path.join(outputDirectory, file))
        .exists()
        .then((exists) => (exists ? unlink(path.join(outputDirectory, file)) : undefined)),
    ),
  )
}
