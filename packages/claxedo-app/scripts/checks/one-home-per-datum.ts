import { moduleStateExceptions } from "./data/module-state-exceptions"
import { codeExtensions, isTestFile, listFiles, packageRoot, rel, under } from "./lib/files"
import { compilerOptions, importsOf, readSource, startLine, ts } from "./lib/parse"
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
const stateFactories = new Set(["createSignal", "createStore", "createMutable", "createResource", "createByteBoundedCache"])
const mutators = new Set(["add", "set", "delete", "clear", "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"])

type ModuleState = Violation & { readonly binding: string }

function main(): never {
  const files = listFiles(packageRoot, ["src"], codeExtensions)
  const violations: Violation[] = []
  const used = new Set<string>()
  for (const state of moduleStates(files, compilerOptions())) {
    const exception = namedException(rel(packageRoot, state.file), state.binding)
    if (exception) used.add(exception)
    else violations.push(state)
  }
  for (const file of files) {
    const { sf } = readSource(file)
    const inServer = under(packageRoot, file, "src/server")
    for (const { specifier, node } of importsOf(sf)) {
      if (!retiredPackages.some((pattern) => pattern.test(specifier))) continue
      violations.push({ file, line: startLine(node, sf), message: `imports ${specifier}; pushed data lives in the domain's Solid store` })
    }
    walk(sf, (node) => {
      for (const message of [cacheWrite(node, inServer), queryKey(node, inServer)]) {
        if (message) violations.push({ file, line: startLine(node, sf), message })
      }
    })
  }
  for (const { file, binding } of moduleStateExceptions) {
    if (!used.has(`${file}#${binding}`)) violations.push({ file, line: 1, message: `named module-state exception ${binding} matches nothing; remove it from data/module-state-exceptions.ts` })
  }
  finish("one-home-per-datum", packageRoot, violations, files.length)
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

export function moduleStates(files: readonly string[], options: ts.CompilerOptions): ModuleState[] {
  const program = ts.createProgram([...files], { ...options, noResolve: true, noLib: true, types: [] })
  const checker = program.getTypeChecker()
  const mutated = new Set<ts.Symbol>()
  for (const sf of program.getSourceFiles()) {
    walk(sf, (node) => {
      const target = mutationTarget(node, checker)
      const symbol = target && bindingSymbol(checker, target)
      if (symbol) mutated.add(symbol)
    })
  }
  return program.getSourceFiles().filter((sf) => !isTestFile(sf.fileName)).flatMap((sf) => sf.statements.flatMap((node) => moduleState(node, sf, checker, mutated)))
}

function moduleState(node: ts.Node, sf: ts.SourceFile, checker: ts.TypeChecker, mutated: ReadonlySet<ts.Symbol>): ModuleState[] {
  if (!ts.isVariableStatement(node) || !isTopLevel(node)) return []
  const mutable = (node.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using)) === 0
  return node.declarationList.declarations.flatMap((declaration) => {
    const binding = ts.isIdentifier(declaration.name) ? declaration.name.text : declaration.name.getText(sf)
    const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined
    const symbol = ts.isIdentifier(declaration.name) && checker.getSymbolAtLocation(declaration.name)
    const written = !!symbol && mutated.has(symbol)
    const message = mutable ? "module-level let or var; state lives in a store owned by a provider"
      : written ? `module-level ${binding} is mutated; state lives in a store owned by a provider`
      : initializer && !isConstantCollection(initializer) ? mutableInitializer(initializer) : undefined
    return message ? [{ file: sf.fileName, line: startLine(declaration, sf), binding, message }] : []
  })
}

function bindingSymbol(checker: ts.TypeChecker, identifier: ts.Identifier): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(identifier)
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
}

function mutationTarget(node: ts.Node, checker: ts.TypeChecker): ts.Identifier | undefined {
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression)
    return ts.isPropertyAccessExpression(callee) && mutators.has(callee.name.text) && collectionReceiver(callee.expression, checker) ? baseName(callee.expression) : undefined
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return baseName(node.left)
  if (ts.isDeleteExpression(node)) return baseName(node.expression)
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return baseName(node.operand)
  return undefined
}

function collectionReceiver(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const target = unwrap(expression)
  const symbol = ts.isIdentifier(target) ? bindingSymbol(checker, target) : checker.getSymbolAtLocation(target)
  return symbol?.declarations?.some((declaration) => {
    if (!ts.isVariableDeclaration(declaration) && !ts.isPropertyAssignment(declaration) && !ts.isPropertyDeclaration(declaration) && !ts.isPropertySignature(declaration)) return false
    const initializer = "initializer" in declaration && declaration.initializer ? unwrap(declaration.initializer) : undefined
    if (initializer && ts.isArrayLiteralExpression(initializer)) return true
    if (initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression) && mutableContainers.has(initializer.expression.text)) return true
    const type = "type" in declaration ? declaration.type : undefined
    return !!type && (ts.isArrayTypeNode(type) || (ts.isTypeReferenceNode(type) && ["Array", ...mutableContainers].includes(type.typeName.getText())))
  }) ?? false
}

function baseName(expression: ts.Expression): ts.Identifier | undefined {
  let current = unwrap(expression)
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrap(current.expression)
  return ts.isIdentifier(current) ? current : undefined
}

function isConstantCollection(expression: ts.Expression): boolean {
  if (!ts.isNewExpression(expression) || !ts.isIdentifier(expression.expression)) return false
  if (expression.expression.text !== "Set" && expression.expression.text !== "Map") return false
  const args = expression.arguments ?? []
  const [only] = args
  return args.length === 0 || (args.length === 1 && only !== undefined && ts.isArrayLiteralExpression(unwrap(only)))
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

if (import.meta.main) main()
