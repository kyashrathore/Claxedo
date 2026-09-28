import { constants as fsConstants } from "fs"
import fs from "fs/promises"
import path from "path"
import { isDeepStrictEqual } from "util"
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type JSONPath, type Node, type ParseError } from "jsonc-parser"
import { writeIfChanged as writeFileAtomically } from "./core/utils"
import { rec, str } from "../json-value"

export type IsManagedCommand = (command: string | undefined) => boolean

/**
 * A person's JSON config edited in place: each change is a text edit, so every
 * byte outside Claxedo's own entries, including formatting and key order,
 * survives.
 */
export class ConfigEdits {
  private readonly fresh: boolean
  text: string

  constructor(original: string | undefined) {
    this.fresh = !original?.trim()
    this.text = this.fresh ? "{}\n" : original!
  }

  /** The merged text; a file Claxedo creates is written formatted, a person's keeps its own layout. */
  result(): string {
    return this.fresh ? JSON.stringify(JSON.parse(this.text), null, 2) + "\n" : this.text
  }

  set(target: JSONPath, value: unknown, isArrayInsertion = false) {
    if (value === undefined) {
      this.remove(target)
      return
    }
    this.text = applyEdits(this.text, modify(this.text, target, value, { isArrayInsertion }))
  }

  // jsonc-parser 3.3.1 corrupts the text when removing the last element of an
  // array that is not the last value in its parent, so removals cut the
  // element and its separating comma by node offsets instead.
  private remove(target: JSONPath) {
    const tree = parseTree(this.text)
    const value = tree && findNodeAtLocation(tree, target)
    if (!value?.parent) return
    const node: Node = value.parent.type === "property" ? value.parent : value
    const siblings = node.parent?.children ?? [node]
    const index = siblings.indexOf(node)
    const end = (sibling: Node) => sibling.offset + sibling.length
    const container = node.parent ?? node
    const [from, to] = siblings.length === 1 ? [container.offset + 1, end(container) - 1]
      : index > 0 ? [end(siblings[index - 1]), end(node)] : [node.offset, siblings[1].offset]
    this.text = this.text.slice(0, from) + this.text.slice(to)
  }
}

function commandOf(entry: unknown) {
  return str(rec(entry)?.command)
}

/**
 * Flat registrations (`event: [{ command, … }]`). Claxedo's entries are removed
 * and its one desired entry appended; the person's entries keep their order.
 */
export function reconcileFlatEntries(edits: ConfigEdits, base: JSONPath, container: Record<string, unknown> | undefined,
  desired: Record<string, Record<string, unknown>>, isManaged: IsManagedCommand) {
  if (!container) {
    edits.set(base, Object.fromEntries(Object.entries(desired).map(([event, entry]) => [event, [entry]])))
    return
  }
  for (const [event, current] of Object.entries(container)) {
    if (!Array.isArray(current)) {
      if (desired[event]) throw new Error(`Hook config has a non-array ${event} entry; refusing to rewrite it`)
      continue
    }
    const managed = current.flatMap((entry, index) => isManaged(commandOf(entry)) ? [index] : [])
    const wanted = desired[event]
    if (wanted && managed.length === 1 && isDeepStrictEqual(current[managed[0]], wanted)) continue
    if (managed.length === 0 && !wanted) continue
    if (!wanted && managed.length === current.length) {
      edits.set([...base, event], undefined)
      continue
    }
    for (const index of managed.toReversed()) edits.set([...base, event, index], undefined)
    if (wanted) edits.set([...base, event, -1], wanted, true)
  }
  for (const [event, wanted] of Object.entries(desired)) {
    if (container[event] === undefined) edits.set([...base, event], [wanted])
  }
}

/**
 * Nested registrations (`event: [{ matcher?, hooks: [{ type, command }] }]`).
 * A definition holding only Claxedo's commands is removed whole; one the
 * person shares keeps its other commands.
 */
export function reconcileNestedEntries(edits: ConfigEdits, base: JSONPath, container: Record<string, unknown> | undefined,
  desired: Record<string, Record<string, unknown>>, isManaged: IsManagedCommand) {
  if (!container) {
    edits.set(base, Object.fromEntries(Object.entries(desired).map(([event, definition]) => [event, [definition]])))
    return
  }
  for (const [event, current] of Object.entries(container)) {
    if (!Array.isArray(current)) {
      if (desired[event]) throw new Error(`Hook config has a non-array ${event} entry; refusing to rewrite it`)
      continue
    }
    const plan = current.map((definition) => {
      const hooks = rec(definition)?.hooks
      const inner = Array.isArray(hooks) ? hooks : []
      const owned = inner.flatMap((hook, index) => isManaged(commandOf(hook)) ? [index] : [])
      return { definition, owned, whole: owned.length > 0 && owned.length === inner.length }
    })
    const touched = plan.filter((row) => row.owned.length > 0)
    const wanted = desired[event]
    if (wanted && touched.length === 1 && touched[0].whole && isDeepStrictEqual(touched[0].definition, wanted)) continue
    if (touched.length === 0 && !wanted) continue
    if (!wanted && plan.every((row) => row.whole)) {
      edits.set([...base, event], undefined)
      continue
    }
    for (const [index, row] of [...plan.entries()].toReversed()) {
      if (row.whole) edits.set([...base, event, index], undefined)
      else for (const hook of row.owned.toReversed()) edits.set([...base, event, index, "hooks", hook], undefined)
    }
    if (wanted) edits.set([...base, event, -1], wanted, true)
  }
  for (const [event, wanted] of Object.entries(desired)) {
    if (container[event] === undefined) edits.set([...base, event], [wanted])
  }
}

export class ConfigChangedError extends Error {}

async function unlessMissing<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

function duplicateKey(node: Node): string | undefined {
  if (node.type === "object") {
    const keys = (node.children ?? []).map((property) => property.children?.[0]?.value)
    const duplicate = keys.find((key, index) => keys.indexOf(key) !== index)
    if (duplicate !== undefined) return String(duplicate)
  }
  for (const child of node.children ?? []) {
    const found = duplicateKey(child)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * A person's config, analysed with the same parser its edits use. Anything the
 * edits could misplace is refused before a byte changes: invalid JSON,
 * comments, a byte-order mark, duplicate keys, or a link that points nowhere.
 */
export async function readConfig(file: string): Promise<{ original: string | undefined; value: Record<string, unknown> }> {
  const link = await unlessMissing(fs.lstat(file))
  if (!link) return { original: undefined, value: {} }
  if (link.isSymbolicLink() && !(await unlessMissing(fs.stat(file)))) {
    throw new Error(`Hook target config ${file} is a link to a missing file; refusing to replace the link`)
  }
  const original = await fs.readFile(file, "utf8")
  if (!original.trim()) return { original, value: {} }
  const errors: ParseError[] = []
  const tree = original.startsWith("\uFEFF") ? undefined : parseTree(original, errors, { disallowComments: true, allowTrailingComma: false })
  if (!tree || errors.length) {
    throw new Error(`Hook target config ${file} contains invalid JSON; fix it before materializing hooks (refusing to rewrite a file that cannot be parsed)`)
  }
  const duplicate = duplicateKey(tree)
  if (duplicate !== undefined) throw new Error(`Hook target config ${file} repeats the key ${JSON.stringify(duplicate)}; refusing to rewrite it`)
  const value: unknown = getNodeValue(tree)
  const object = rec(value)
  if (!object || Array.isArray(value)) throw new Error(`Hook target config ${file} is not a JSON object; refusing to rewrite it`)
  return { original, value: object }
}

/**
 * Writes a merged config only when its text changed. The person's file is
 * refused when it is read-only, and a merge whose file changed after it was
 * read raises ConfigChangedError so the caller merges again. A link lands on
 * its target with the target's mode; a hard-linked file is rewritten in place
 * so every name keeps pointing at it; any other file is replaced atomically.
 */
export async function writeMergedConfig(file: string, original: string | undefined, text: string) {
  if (text === original) return
  if (original === undefined) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 })
    if (await unlessMissing(fs.lstat(file))) throw new ConfigChangedError(`${file} appeared while merging`)
    await writeFileAtomically(file, text, 0o644, true)
    return
  }
  const target = await fs.realpath(file)
  await fs.access(target, fsConstants.W_OK).catch((cause: unknown) => {
    throw new Error(`Hook target config ${file} is read-only; refusing to replace it`, { cause })
  })
  if (await fs.readFile(target, "utf8") !== original) throw new ConfigChangedError(`${file} changed while merging`)
  const stat = await fs.stat(target)
  if (stat.nlink > 1) await fs.writeFile(target, text)
  else await writeFileAtomically(target, text, stat.mode & 0o777, true)
}
