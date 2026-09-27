import { startLine, ts } from "./parse"
import { isFunctionNode, unwrap, walk, type FunctionNode } from "./tree"

export type Origin = { readonly file: string; readonly line: number; readonly name: string }
export type DirectoryValues = { readonly originOf: (expression: ts.Expression) => Origin | undefined }

type Flow = { readonly origin?: Origin; readonly params: ReadonlySet<ts.Node> }
type Summary = { readonly origin?: Origin; readonly indices: ReadonlySet<number> }

const none: Flow = { params: new Set() }
const joinedOperators = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken])
const nullish = ts.TypeFlags.Undefined | ts.TypeFlags.Null
const opaque =
  ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void | nullish | ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike

export function traceDirectories(program: ts.Program, files: readonly string[], names: ReadonlySet<string>): DirectoryValues {
  const tracer = new DirectoryTracer(program.getTypeChecker(), new Set(files), names)
  const sources = files.map((file) => program.getSourceFile(file)).filter((sf): sf is ts.SourceFile => sf !== undefined)
  do {
    tracer.changed = false
    for (const sf of sources) walk(sf, (node) => tracer.propagate(node))
  } while (tracer.changed)
  return { originOf: (expression) => tracer.effective(tracer.flowOf(expression)) }
}

class DirectoryTracer {
  changed = true
  private readonly values = new Map<ts.Node, Flow>()
  private readonly params = new Map<ts.Node, Origin>()
  private readonly returns = new Map<ts.Node, Summary>()

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly scanned: ReadonlySet<string>,
    private readonly names: ReadonlySet<string>,
  ) {}

  propagate(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) this.markValue(node, this.flowOf(node.initializer))
      this.transfer(node.initializer)
    } else if (ts.isBindingElement(node)) this.propagateBinding(node)
    else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) this.propagateProperty(node)
    else if (ts.isCallExpression(node)) this.propagateCall(node)
    else if (isFunctionNode(node) && node.body) this.propagateFunction(node)
  }

  effective(flow: Flow): Origin | undefined {
    return flow.origin ?? [...flow.params].map((param) => this.paramOrigin(param)).find(Boolean)
  }

  flowOf(node: ts.Expression): Flow {
    const expression = unwrap(node)
    if (ts.isAwaitExpression(expression)) return this.flowOf(expression.expression)
    if (ts.isIdentifier(expression)) return this.flowOfSymbol(this.checker.getSymbolAtLocation(expression))
    if (ts.isPropertyAccessExpression(expression)) return this.flowOfSymbol(this.checker.getSymbolAtLocation(expression.name))
    if (ts.isCallExpression(expression)) return this.flowOfCall(expression)
    if (ts.isConditionalExpression(expression)) return join([this.flowOf(expression.whenTrue), this.flowOf(expression.whenFalse)])
    if (ts.isTemplateExpression(expression)) return join(expression.templateSpans.map((span) => this.flowOf(span.expression)))
    if (!ts.isBinaryExpression(expression)) return none
    const operator = expression.operatorToken.kind
    if (joinedOperators.has(operator)) return join([this.flowOf(expression.left), this.flowOf(expression.right)])
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.CommaToken) return this.flowOf(expression.right)
    return none
  }

  private flowOfCall(call: ts.CallExpression): Flow {
    const declaration = this.checker.getResolvedSignature(call)?.getDeclaration()
    const summary = declaration ? this.returns.get(declaration) : undefined
    const argumentFlows = [...(summary?.indices ?? [])].map((index) => call.arguments[index]).map((argument) => (argument ? this.flowOf(argument) : none))
    const callee = unwrap(call.expression)
    const onString = ts.isPropertyAccessExpression(callee) && isStringLike(this.checker.getTypeAtLocation(callee.expression))
    const receiver = onString ? this.flowOf(callee.expression) : none
    const named = declaration ? this.namedOrigin(declaration) : undefined
    return join([{ origin: named ?? summary?.origin, params: none.params }, ...argumentFlows, receiver])
  }

  private flowOfSymbol(symbol: ts.Symbol | undefined): Flow {
    return join(this.declarationsOf(symbol).map((declaration) => this.flowOfDeclaration(declaration)))
  }

  private flowOfDeclaration(declaration: ts.Node): Flow {
    if (ts.isParameter(declaration)) return { params: new Set([declaration]) }
    const origin = this.namedOrigin(declaration)
    return origin ? { origin, params: none.params } : (this.values.get(declaration) ?? none)
  }

  private declarationsOf(symbol: ts.Symbol | undefined): ts.Node[] {
    if (!symbol) return []
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol
    return [...new Set([resolved, ...this.checker.getRootSymbols(resolved)].flatMap((item) => item.declarations ?? []))]
  }

  private namedOrigin(declaration: ts.Node): Origin | undefined {
    const name = declarationName(declaration)
    if (!name || !this.names.has(name)) return undefined
    const sf = declaration.getSourceFile()
    return { file: sf.fileName, line: startLine(declaration, sf), name }
  }

  private paramOrigin(param: ts.Node): Origin | undefined {
    return this.params.get(param) ?? this.namedOrigin(param)
  }

  private propagateFunction(fn: FunctionNode): void {
    const signatures = this.contextualSignatures(fn)
    fn.parameters.forEach((param, index) => {
      for (const signature of signatures) {
        const linked = signature.parameters[index]
        if (linked) this.markParam(param, this.paramOrigin(linked))
      }
    })
    const flow = join(returnedExpressions(fn).map((expression) => {
      this.transfer(expression)
      return this.flowOf(expression)
    }))
    const own = new Set<ts.Node>(fn.parameters)
    const outer = [...flow.params].filter((param) => !own.has(param)).map((param) => this.paramOrigin(param)).find(Boolean)
    const indices = new Set(fn.parameters.flatMap((param, index) => (flow.params.has(param) ? [index] : [])))
    for (const signature of [fn, ...signatures]) this.markReturn(signature, { origin: flow.origin ?? outer, indices })
  }

  private contextualSignatures(fn: FunctionNode): ts.SignatureDeclaration[] {
    const type = contextualFunctionType(this.checker, fn)
    const declarations = (type?.getCallSignatures() ?? []).map((signature) => signature.getDeclaration())
    return declarations.filter((declaration) => isMemberSignature(declaration) && this.scanned.has(declaration.getSourceFile().fileName))
  }

  private propagateCall(call: ts.CallExpression): void {
    const declaration = this.checker.getResolvedSignature(call)?.getDeclaration()
    call.arguments.forEach((argument, index) => {
      this.transfer(argument)
      if (declaration && ts.isFunctionLike(declaration)) this.markParam(parameterAt(declaration, index), this.effective(this.flowOf(argument)))
    })
  }

  private propagateBinding(element: ts.BindingElement): void {
    if (!ts.isObjectBindingPattern(element.parent)) return
    const key = element.propertyName ?? element.name
    if (!ts.isIdentifier(key)) return
    const property = this.checker.getPropertyOfType(this.checker.getTypeAtLocation(element.parent), key.text)
    this.markProperty(element, this.effective(this.flowOfSymbol(property)))
  }

  private propagateProperty(property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): void {
    if (!ts.isObjectLiteralExpression(property.parent)) return
    const flow = ts.isShorthandPropertyAssignment(property)
      ? this.flowOfSymbol(this.checker.getShorthandAssignmentValueSymbol(property))
      : this.flowOf(property.initializer)
    if (ts.isPropertyAssignment(property)) this.transfer(property.initializer)
    const origin = this.effective(flow)
    this.markProperty(property, origin)
    this.markTargetProperty(this.checker.getContextualType(property.parent), property.name.getText(), origin)
  }

  private transfer(expression: ts.Expression): void {
    const target = this.checker.getContextualType(expression)
    const source = this.checker.getTypeAtLocation(expression)
    if (!target || source.flags & opaque) return
    for (const property of this.checker.getPropertiesOfType(source)) {
      const origin = this.effective(this.flowOfSymbol(property))
      if (origin) this.markTargetProperty(target, property.name, origin)
    }
  }

  private markTargetProperty(target: ts.Type | undefined, name: string, origin: Origin | undefined): void {
    if (!target || !origin) return
    for (const part of target.isUnion() ? target.types : [target]) {
      for (const declaration of this.declarationsOf(this.checker.getPropertyOfType(part, name))) this.markProperty(declaration, origin)
    }
  }

  private markValue(declaration: ts.Node, flow: Flow): void {
    if (!flow.origin && flow.params.size === 0) return
    const current = this.values.get(declaration)
    const merged = { origin: current?.origin ?? flow.origin, params: new Set([...(current?.params ?? []), ...flow.params]) }
    if (current && merged.origin === current.origin && merged.params.size === current.params.size) return
    this.values.set(declaration, merged)
    this.changed = true
  }

  private markProperty(declaration: ts.Node, origin: Origin | undefined): void {
    this.markValue(declaration, { origin, params: none.params })
  }

  private markParam(param: ts.Node | undefined, origin: Origin | undefined): void {
    if (!param || !origin || this.params.has(param)) return
    this.params.set(param, origin)
    this.changed = true
  }

  private markReturn(signature: ts.Node, summary: Summary): void {
    if (!summary.origin && summary.indices.size === 0) return
    const current = this.returns.get(signature)
    const merged = { origin: current?.origin ?? summary.origin, indices: new Set([...(current?.indices ?? []), ...summary.indices]) }
    if (current && merged.origin === current.origin && merged.indices.size === current.indices.size) return
    this.returns.set(signature, merged)
    this.changed = true
  }
}

function join(flows: readonly Flow[]): Flow {
  const origin = flows.find((flow) => flow.origin)?.origin
  const params = new Set(flows.flatMap((flow) => [...flow.params]))
  return origin || params.size > 0 ? { origin, params } : none
}

function declarationName(declaration: ts.Node): string | undefined {
  const named = declaration as ts.Node & { readonly name?: ts.Node }
  if (named.name && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name))) return named.name.text
  const parent = declaration.parent
  if ((ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && parent && ts.isPropertyAssignment(parent)) {
    return ts.isIdentifier(parent.name) ? parent.name.text : undefined
  }
  return undefined
}

function parameterAt(declaration: ts.SignatureDeclaration, index: number): ts.ParameterDeclaration | undefined {
  const last = declaration.parameters.at(-1)
  return declaration.parameters[index] ?? (last?.dotDotDotToken ? last : undefined)
}

function isMemberSignature(declaration: ts.Node | undefined): declaration is ts.SignatureDeclaration {
  if (!declaration) return false
  if (ts.isMethodSignature(declaration)) return true
  return ts.isFunctionTypeNode(declaration) && ts.isPropertySignature(declaration.parent)
}

function isStringLike(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every((part) => (part.getFlags() & (ts.TypeFlags.StringLike | nullish)) !== 0)
  return (type.getFlags() & ts.TypeFlags.StringLike) !== 0
}

function contextualFunctionType(checker: ts.TypeChecker, fn: FunctionNode): ts.Type | undefined {
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) return checker.getContextualType(fn)
  if (!ts.isMethodDeclaration(fn) || !ts.isObjectLiteralExpression(fn.parent)) return undefined
  const property = checker.getContextualType(fn.parent)?.getProperty(fn.name.getText())
  return property ? checker.getTypeOfSymbol(property) : undefined
}

function returnedExpressions(fn: FunctionNode): ts.Expression[] {
  if (!fn.body) return []
  if (!ts.isBlock(fn.body)) return [fn.body]
  const found: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (isFunctionNode(node)) return
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression)
    node.forEachChild(visit)
  }
  fn.body.forEachChild(visit)
  return found
}
