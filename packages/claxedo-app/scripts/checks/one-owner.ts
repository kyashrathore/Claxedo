import { codeExtensions, listFiles, packageRoot, rel, topFolder } from "./lib/files"
import { readSource, startLine, ts, type Source } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { hasExportModifier } from "./lib/tree"

type Export = { readonly file: string; readonly line: number; readonly name: string; readonly unit: string }
type Row = { readonly line: number; readonly text: string }
type Place = { readonly file: string; readonly row: number; readonly rows: readonly Row[] }

const windowLines = 25

function main(): never {
  const files = listFiles(packageRoot, ["src"], codeExtensions)
  const sources = files.map(readSource)
  const violations = [...duplicateExports(packageRoot, sources), ...duplicateBlocks(packageRoot, sources)]
  finish("one-owner", packageRoot, violations, files.length)
}

function duplicateExports(root: string, sources: readonly Source[]): Violation[] {
  const byName = new Map<string, Export[]>()
  for (const source of sources) {
    const unit = unitOf(root, source.file)
    if (!unit) continue
    for (const item of exportsOf(source, unit)) byName.set(item.name, [...(byName.get(item.name) ?? []), item])
  }
  const violations: Violation[] = []
  for (const items of byName.values()) {
    if (new Set(items.map((item) => item.unit)).size < 2) continue
    for (const item of items) {
      const other = items.find((candidate) => candidate.unit !== item.unit)
      if (!other) continue
      const message = `exported name ${item.name} is also defined in ${rel(root, other.file)}; one owner per concept`
      violations.push({ file: item.file, line: item.line, message })
    }
  }
  return violations
}

function unitOf(root: string, file: string): string | undefined {
  const domain = topFolder(root, file, "src")
  return domain && domain !== "lib" ? `src/${domain}` : undefined
}

function exportsOf({ file, sf }: Source, unit: string): Export[] {
  const out: Export[] = []
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      const local = !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)
      const elements = local && statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : []
      for (const element of elements) out.push({ file, line: startLine(element, sf), name: element.name.text, unit })
    } else if (hasExportModifier(statement) && !isDefaultExport(statement)) {
      for (const name of declaredNames(statement)) out.push({ file, line: startLine(statement, sf), name, unit })
    }
  }
  return out
}

function isDefaultExport(statement: ts.Statement): boolean {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name))
  }
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  return named && statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : []
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []))
}

function duplicateBlocks(root: string, sources: readonly Source[]): Violation[] {
  const index = new Map<string, Place>()
  const violations: Violation[] = []
  for (const source of sources) {
    const rows = normalizedRows(source.text)
    const hashes = rows.map((row) => Bun.hash(row.text).toString())
    let last: { readonly partner: Place; readonly row: number } | undefined
    for (let row = 0; row + windowLines <= rows.length; row += 1) {
      const key = Bun.hash(hashes.slice(row, row + windowLines).join(",")).toString()
      const owner = index.get(key)
      if (!owner) {
        index.set(key, { file: source.file, row, rows })
        continue
      }
      if ((owner.file === source.file && row - owner.row < windowLines) || !sameRows(owner, rows, row)) continue
      const continues = last !== undefined && last.partner.file === owner.file && owner.row - last.partner.row === row - last.row
      last = { partner: owner, row }
      if (continues) continue
      const origin = `${rel(root, owner.file)}:${owner.rows[owner.row]?.line ?? 0}`
      violations.push({ file: source.file, line: rows[row]?.line ?? 0, message: `${windowLines}+ lines duplicate ${origin}; one owner per concept` })
    }
  }
  return violations
}

function normalizedRows(text: string): Row[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line.replace(/\s+/g, " ").trim() }))
    .filter((row) => row.text.length > 0)
}

function sameRows(owner: Place, rows: readonly Row[], row: number): boolean {
  for (let offset = 0; offset < windowLines; offset += 1) {
    if (owner.rows[owner.row + offset]?.text !== rows[row + offset]?.text) return false
  }
  return true
}

main()
