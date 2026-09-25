import { join } from "node:path"
import { readSource, ts } from "./parse"
import { calleeName, enclosingFunction, functionName, unwrap, walk } from "./tree"

export type Template = readonly (string | undefined)[]
export type KeyTemplates = ReadonlyMap<string, Template>
export type KeyReference = { readonly name: string; readonly node: ts.PropertyAccessExpression; readonly kind: "read" | "invalidation" }
export type EventInvalidations = ReadonlyMap<string, ReadonlySet<string>>

export const queryKeysPath = "src/server/query-keys.ts"
export const invalidationTablePath = "src/server/queries.ts"
const invalidationTableFunction = "invalidationKeys"
const invalidationCalls = new Set(["invalidateQueries", "removeQueries", "refetchQueries", "cancelQueries", "resetQueries", "setQueriesData"])

export function readTemplates(root: string): KeyTemplates {
  const file = join(root, queryKeysPath)
  const { sf } = readSource(file)
  const out = new Map<string, Template>()
  walk(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "queryKeys" || !node.initializer) return
    const object = unwrap(node.initializer)
    if (!ts.isObjectLiteralExpression(object)) throw new Error(`${file}: queryKeys is not an object literal`)
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) throw new Error(`${file}: queryKeys has a member that is not a named property`)
      out.set(property.name.text, templateOf(file, property.name.text, property.initializer))
    }
  })
  if (out.size === 0) throw new Error(`${file}: no queryKeys object found`)
  return out
}

function templateOf(file: string, name: string, initializer: ts.Expression): Template {
  const fn = unwrap(initializer)
  const body = ts.isArrowFunction(fn) && !ts.isBlock(fn.body) ? unwrap(fn.body) : undefined
  if (!body || !ts.isArrayLiteralExpression(body)) throw new Error(`${file}: queryKeys.${name} is not an arrow function returning an array literal`)
  return body.elements.map((element) => (ts.isStringLiteral(element) ? element.text : undefined))
}

export function isPrefix(prefix: Template, template: Template): boolean {
  if (prefix.length > template.length) return false
  return prefix.every((part, index) => part === undefined || template[index] === undefined || part === template[index])
}

export function keyReferences(sf: ts.SourceFile, inInvalidationTable: boolean): KeyReference[] {
  const refs: KeyReference[] = []
  walk(sf, (node) => {
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "queryKeys") return
    refs.push({ name: node.name.text, node, kind: invalidates(node, inInvalidationTable) ? "invalidation" : "read" })
  })
  return refs
}

function invalidates(node: ts.Node, inInvalidationTable: boolean): boolean {
  if (inInvalidationTable && insideInvalidationTable(node)) return true
  let current = node.parent
  while (current) {
    if (ts.isCallExpression(current) && invalidationCalls.has(calleeName(current) ?? "")) return true
    current = current.parent
  }
  return false
}

function insideInvalidationTable(node: ts.Node): boolean {
  let fn = enclosingFunction(node)
  while (fn) {
    if (functionName(fn) === invalidationTableFunction) return true
    fn = enclosingFunction(fn)
  }
  return false
}

export function readEventInvalidations(sf: ts.SourceFile): EventInvalidations {
  const table = new Map<string, Set<string>>()
  const fn = invalidationTable(sf)
  if (!fn) throw new Error(`${sf.fileName}: no ${invalidationTableFunction} function`)
  let pending: string[] = []
  walk(fn, (node) => {
    if (!ts.isCaseBlock(node)) return
    for (const clause of node.clauses) {
      if (ts.isDefaultClause(clause)) {
        pending = []
        continue
      }
      const label = unwrap(clause.expression)
      pending.push(ts.isStringLiteral(label) ? label.text : label.getText(sf))
      if (clause.statements.length === 0) continue
      const names = clause.statements.flatMap(namesIn)
      for (const event of pending) table.set(event, new Set([...(table.get(event) ?? []), ...names]))
      pending = []
    }
  })
  return table
}

function invalidationTable(sf: ts.SourceFile): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined
  walk(sf, (node) => {
    if (!found && ts.isFunctionDeclaration(node) && node.name?.text === invalidationTableFunction) found = node
  })
  return found
}

function namesIn(node: ts.Node): string[] {
  const names: string[] = []
  walk(node, (child) => {
    if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "queryKeys") names.push(child.name.text)
  })
  return names
}

export function eventsInvalidating(cache: Template, table: EventInvalidations, templates: KeyTemplates): ReadonlySet<string> {
  const events = new Set<string>()
  for (const [event, names] of table) {
    for (const name of names) {
      const template = templates.get(name)
      if (template && isPrefix(template, cache)) events.add(event)
    }
  }
  return events
}
