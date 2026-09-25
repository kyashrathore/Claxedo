import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript-api"

type Entry = { readonly file: string; readonly name: string }
type Edit = { readonly file: string; readonly start: number; readonly end: number; readonly text: string }

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const retired = /[a-z0-9]IDs?$/
const contractFields = new Set(["sessionID", "messageID", "partID", "providerID", "modelID"])
const contractPackages = ["/agent-runtime-contract/", "/agent-event-runtime/"]
const declarationKinds: readonly ((node: ts.Node) => boolean)[] = [
  ts.isVariableDeclaration,
  ts.isParameter,
  ts.isPropertySignature,
  ts.isPropertyDeclaration,
  ts.isPropertyAssignment,
  ts.isShorthandPropertyAssignment,
  ts.isMethodDeclaration,
  ts.isMethodSignature,
  ts.isFunctionDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isInterfaceDeclaration,
  ts.isBindingElement,
  ts.isGetAccessor,
  ts.isSetAccessor,
]
const contents = new Map<string, string>()
const versions = new Map<string, number>()

const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, "tsconfig.json"), (path) => ts.sys.readFile(path)).config, ts.sys, root)
const service = ts.createLanguageService(
  {
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: (file) => String(versions.get(file) ?? 0),
    getScriptSnapshot: (file) => {
      const text = contents.get(file) ?? ts.sys.readFile(file)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (path) => ts.sys.fileExists(path),
    readFile: (path) => ts.sys.readFile(path),
    readDirectory: (path, extensions, exclude, include, depth) => ts.sys.readDirectory(path, extensions, exclude, include, depth),
    directoryExists: (path) => ts.sys.directoryExists(path),
    getDirectories: (path) => ts.sys.getDirectories(path),
  },
  ts.createDocumentRegistry(),
)

function claxedoName(name: string): string {
  return name.replace(/ID(s?)$/, "Id$1")
}

function program(): ts.Program {
  const current = service.getProgram()
  if (!current) throw new Error("the language service has no program")
  return current
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent
  const named = parent as ts.Node & { readonly name?: ts.Node }
  if (named.name !== node || contractOwned(node)) return false
  return declarationKinds.some((is) => is(parent))
}

function declarations(entry: Entry): number[] {
  const sf = program().getSourceFile(join(root, entry.file))
  if (!sf) throw new Error(`${entry.file} is not in the program`)
  const found: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === entry.name && isDeclarationName(node)) found.push(node.getStart(sf))
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function renameEdits(file: string, position: number, name: string): Edit[] {
  const locations = service.findRenameLocations(file, position, false, false, { providePrefixAndSuffixTextForRename: true }) ?? []
  return locations.map((location) => ({
    file: location.fileName,
    start: location.textSpan.start,
    end: location.textSpan.start + location.textSpan.length,
    text: `${location.prefixText ?? ""}${claxedoName(name)}${location.suffixText ?? ""}`,
  }))
}

function apply(edits: readonly Edit[]): void {
  const byFile = new Map<string, Edit[]>()
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit])
  for (const [file, fileEdits] of byFile) {
    let text = contents.get(file) ?? readFileSync(file, "utf8")
    for (const edit of [...fileEdits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
    contents.set(file, text)
    versions.set(file, (versions.get(file) ?? 0) + 1)
  }
}

function round(entries: readonly Entry[], log: string[]): boolean {
  const claimed = new Set<string>()
  const batch: Edit[] = []
  for (const entry of entries) {
    const [position] = declarations(entry)
    if (position === undefined) continue
    const edits = renameEdits(join(root, entry.file), position, entry.name)
    if (edits.some((edit) => claimed.has(`${edit.file}:${edit.start}`))) continue
    for (const edit of edits) claimed.add(`${edit.file}:${edit.start}`)
    batch.push(...edits)
    log.push(`${entry.file}: ${entry.name} → ${claxedoName(entry.name)} at ${edits.length} sites`)
  }
  apply(batch)
  return batch.length > 0
}

function rename(entries: readonly Entry[]): string[] {
  const log: string[] = []
  while (round(entries, log));
  for (const [file, text] of contents) writeFileSync(file, text)
  return log
}

function contractOwned(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!contractFields.has(node.text)) return false
  if (!ts.isPropertyAssignment(parent) && !ts.isShorthandPropertyAssignment(parent)) return false
  if (!ts.isObjectLiteralExpression(parent.parent)) return true
  const contextual = program().getTypeChecker().getContextualType(parent.parent)
  const parts = contextual?.isUnion() ? contextual.types : contextual ? [contextual] : []
  const declared = parts.flatMap((part) => part.getProperty(node.text)?.declarations ?? [])
  return declared.some((declaration) => contractPackages.some((folder) => declaration.getSourceFile().fileName.includes(folder)))
}

function discover(files: readonly string[]): Entry[] {
  const entries = new Map<string, Entry>()
  for (const file of files) {
    const sf = program().getSourceFile(join(root, file))
    if (!sf) throw new Error(`${file} is not in the program`)
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && retired.test(node.text) && isDeclarationName(node)) {
        entries.set(`${file}#${node.text}`, { file, name: node.text })
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return [...entries.values()]
}

function readEntries(file: string): Entry[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (!Array.isArray(parsed)) throw new Error(`${file} is not a list of { file, name }`)
  return parsed.map((item: unknown) => {
    if (typeof item !== "object" || item === null || !("file" in item) || !("name" in item)) throw new Error(`${file} has an entry without file and name`)
    if (typeof item.file !== "string" || typeof item.name !== "string") throw new Error(`${file} has an entry without file and name`)
    return { file: item.file, name: item.name }
  })
}

function main(): void {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode === "discover") {
    console.log(JSON.stringify(discover(rest.map((file) => relative(root, resolve(file)))), null, 2))
    return
  }
  if (mode === "apply" && rest[0]) {
    const entries = readEntries(rest[0])
    console.log(rename(entries).join("\n"))
    return
  }
  console.error("usage: bun scripts/codemods/rename-ids.ts discover <file>... | apply <list.json>")
  process.exit(2)
}

main()
