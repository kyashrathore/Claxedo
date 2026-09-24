import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript-api"
import { packageRoot } from "./files"

export { ts }

export type Source = { readonly file: string; readonly text: string; readonly sf: ts.SourceFile }

export function readSource(file: string): Source {
  const text = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, scriptKind(file))
  return { file, text, sf }
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (file.endsWith(".ts")) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

export function lineAt(sf: ts.SourceFile, position: number): number {
  return sf.getLineAndCharacterOfPosition(position).line + 1
}

export function startLine(node: ts.Node, sf: ts.SourceFile): number {
  return lineAt(sf, node.getStart(sf))
}

export function endLine(node: ts.Node, sf: ts.SourceFile): number {
  return lineAt(sf, node.getEnd())
}

export function lineCount(text: string): number {
  if (text.length === 0) return 0
  const lines = text.split("\n").length
  return text.endsWith("\n") ? lines - 1 : lines
}

export function compilerOptions(): ts.CompilerOptions {
  const configPath = join(packageRoot, "tsconfig.json")
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    },
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host)
  if (!parsed) throw new Error(`cannot parse ${configPath}`)
  return parsed.options
}

export function createProgram(files: readonly string[], options: ts.CompilerOptions): ts.Program {
  return ts.createProgram({ rootNames: [...files], options })
}

export type Resolver = (from: string, specifier: string) => string | undefined

export function createResolver(options: ts.CompilerOptions): Resolver {
  const cache = ts.createModuleResolutionCache(ts.sys.getCurrentDirectory(), (name) => name, options)
  return (from, specifier) => {
    const resolved = ts.resolveModuleName(specifier, from, options, ts.sys, cache).resolvedModule?.resolvedFileName
    if (!resolved) return undefined
    return existsSync(resolved) ? realpathSync(resolved) : resolved
  }
}

export type ImportRef = { readonly specifier: string; readonly node: ts.Node }

export function importsOf(sf: ts.SourceFile): ImportRef[] {
  const refs: ImportRef[] = []
  const visit = (node: ts.Node): void => {
    const specifier = importSpecifier(node)
    if (specifier !== undefined) refs.push({ specifier, node })
    node.forEachChild(visit)
  }
  visit(sf)
  return refs
}

function importSpecifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return ts.isStringLiteral(node.moduleReference.expression) ? node.moduleReference.expression.text : undefined
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
    return node.argument.literal.text
  }
  if (ts.isCallExpression(node) && isModuleLoad(node.expression)) {
    const [argument] = node.arguments
    return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined
  }
  return undefined
}

function isModuleLoad(callee: ts.Expression): boolean {
  return callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")
}

export function isImportSpecifierNode(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent) return false
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return parent.moduleSpecifier === node
  if (ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent)) return true
  return ts.isCallExpression(parent) && isModuleLoad(parent.expression) && parent.arguments[0] === node
}
