import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codeExtensions, isTranslationFile, listFiles, parseArgs, under } from "./lib/files"
import { compilerOptions, createProgram, isImportSpecifierNode, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { slotReaders, type SlotHook, type SlotReaders } from "./lib/slot-readers"
import { textOf, walk } from "./lib/tree"

const retiredIdentifier = /[a-z0-9]IDs?$/
const contractFields = new Set(["sessionID", "messageID", "partID", "providerID", "modelID"])
const retiredWords = new Set(["globalSDK", "globalSync", "OpencodeTheme", "opencodeTheme"])
const retiredStrings = [
  { pattern: /@opencode-ai\//, message: "names an @opencode-ai package" },
  { pattern: /prompt_async|\/experimental\/|\/session\/[^\s"'`]*\/message/, message: "names an OpenCode route" },
  { pattern: /\b(default\.dat|layout\.v6|claxedo\.global\.dat|legacy-directory)\b|\bPersist\./, message: "names the old app's storage" },
  { pattern: /(^|[\s"'`.#>~+(:,])oc-[a-z]/, message: "uses an oc- prefix" },
  { pattern: /\bdata-component\b/, message: "uses the data-component hook" },
]
const exemptPackages = [
  "/packages/agent-runtime-contract/",
  "/packages/agent-event-runtime/",
  "/node_modules/@claxedo/agent-runtime-contract/",
  "/node_modules/@claxedo/agent-event-runtime/",
]
const slotOutsideKit = "uses data-slot outside src/ui; only the kit's components carry slots"

type Lookup = { readonly declarations: readonly ts.Declaration[]; readonly reference: boolean }

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const events = new Set(readFileSync(join(import.meta.dir, "data/server-event-names.txt"), "utf8").split("\n").filter(Boolean))
  const files = listFiles(root, ["src", "plugins"], codeExtensions).filter(
    (file) => !under(root, file, "src/server/wire") && !isTranslationFile(root, file),
  )
  const program = createProgram(files, compilerOptions())
  const checker = program.getTypeChecker()
  const readers = slotReaders(root)
  const violations: Violation[] = []
  for (const file of files) {
    const sf = program.getSourceFile(file)
    if (!sf) continue
    const inKit = under(root, file, "src/ui")
    walk(sf, (node) => {
      const message = retiredName(root, node, checker) ?? retiredText(node, events, inKit, readers)
      if (message) violations.push({ file, line: startLine(node, sf), message })
    })
  }
  finish("claxedo-names", root, violations, files.length)
}

function retiredName(root: string, node: ts.Node, checker: ts.TypeChecker): string | undefined {
  if (!ts.isIdentifier(node) || !(retiredIdentifier.test(node.text) || retiredWords.has(node.text))) return undefined
  if (contractFields.has(node.text) && isPropertyKey(node)) return undefined
  const { declarations, reference } = lookup(node, checker)
  const files = declarations.map((declaration) => declaration.getSourceFile().fileName)
  if (files.some((file) => isExempt(root, file))) return undefined
  if (reference && files.some((file) => under(root, file, "src") || under(root, file, "plugins"))) return undefined
  return `${node.text} is an OpenCode name; use ${claxedoName(node.text)}`
}

function isExempt(root: string, file: string): boolean {
  return under(root, file, "src/server/wire") || exemptPackages.some((folder) => file.includes(folder))
}

function claxedoName(name: string): string {
  if (retiredIdentifier.test(name)) return name.replace(/ID(s?)$/, "Id$1")
  if (name === "globalSDK" || name === "globalSync") return "the server adapter (useServer())"
  return "a Claxedo theme name"
}

function lookup(node: ts.Identifier, checker: ts.TypeChecker): Lookup {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return { declarations: propertyDeclarations(checker.getTypeAtLocation(parent.expression), node.text), reference: false }
  }
  if ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) && parent.name === node) {
    const contextual = ts.isObjectLiteralExpression(parent.parent) ? checker.getContextualType(parent.parent) : undefined
    return { declarations: contextual ? propertyDeclarations(contextual, node.text) : [], reference: false }
  }
  if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent) && (parent.propertyName ?? parent.name) === node) {
    return { declarations: propertyDeclarations(checker.getTypeAtLocation(parent.parent), node.text), reference: false }
  }
  if (ts.isJsxAttribute(parent) && parent.name === node) {
    return { declarations: symbolDeclarations(checker.getSymbolAtLocation(node), checker), reference: false }
  }
  if (isDeclarationName(node)) return { declarations: [], reference: false }
  return { declarations: symbolDeclarations(checker.getSymbolAtLocation(node), checker), reference: true }
}

function propertyDeclarations(type: ts.Type, name: string): ts.Declaration[] {
  const parts = type.isUnion() ? type.types : [type]
  return parts.flatMap((part) => part.getProperty(name)?.declarations ?? [])
}

function symbolDeclarations(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): readonly ts.Declaration[] {
  if (!symbol) return []
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  return target.declarations ?? []
}

function isPropertyKey(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node
  if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) return parent.name === node
  return ts.isBindingElement(parent) && parent.propertyName === node
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent
  const declares =
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isBindingElement(parent) ||
    ts.isTypeParameterDeclaration(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isGetAccessor(parent) ||
    ts.isSetAccessor(parent)
  return declares && parent.name === node
}

function retiredText(node: ts.Node, events: ReadonlySet<string>, inKit: boolean, readers: SlotReaders): string | undefined {
  if (ts.isJsxAttribute(node)) return retiredAttribute(node, inKit, readers)
  const text = textOf(node)
  if (text === undefined || isImportSpecifierNode(node)) return undefined
  if (events.has(text)) return `"${text}" is a server event name; only src/server/wire speaks it`
  const hit = retiredStrings.find(({ pattern }) => pattern.test(text))
  if (hit) return `${hit.message}: "${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`
  return !inKit && /data-slot[=\]]/.test(text) ? slotOutsideKit : undefined
}

function retiredAttribute(node: ts.JsxAttribute, inKit: boolean, readers: SlotReaders): string | undefined {
  const hook = ts.isIdentifier(node.name) ? node.name.text : undefined
  if (hook !== "data-slot" && hook !== "data-component") return undefined
  if (hook === "data-slot" && inKit) return undefined
  const values = attributeValues(node)
  if (values === undefined) return `${hook} has a computed value, so no stylesheet or hook can be shown to read it`
  const unread = values.filter((value) => !readers.selects(hook satisfies SlotHook, value))
  if (unread.length === 0) return undefined
  return `${hook}="${unread.join('" / "')}" is read by no stylesheet, e2e or perf-harness hook; remove it`
}

function attributeValues(node: ts.JsxAttribute): string[] | undefined {
  const value = node.initializer
  if (!value) return undefined
  if (ts.isStringLiteral(value)) return [value.text]
  const expression = ts.isJsxExpression(value) ? value.expression : undefined
  return expression ? literalValues(expression) : undefined
}

function literalValues(expression: ts.Expression): string[] | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text]
  if (ts.isParenthesizedExpression(expression)) return literalValues(expression.expression)
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = literalValues(expression.whenTrue)
    const whenFalse = literalValues(expression.whenFalse)
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : undefined
  }
  if (expression.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(expression) && expression.text === "undefined")) return []
  return undefined
}

main()
