import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { codeExtensions, packageRoot, pluginsDirectory, repoRoot, styleExtensions } from "./files"

export type SlotHook = "data-slot" | "data-component"

export type Selector = { readonly hook: SlotHook; readonly operator: string; readonly value: string }

export type SlotHooks = {
  readonly selects: (hook: SlotHook, value: string) => boolean
  readonly written: (selector: Selector) => boolean
  readonly write: (hook: SlotHook, value: string) => void
}

const bracketSelector = /\[\s*data-(slot|component)\s*([~|^$*]?=)\s*["']?([^"'\]\s]+)["']?\s*\]/g
const tailwindVariant = /data-\[(slot|component)=([^\]]+)\]/g
const attributeCompare = /(?:getAttribute\(\s*["']data-(slot|component)["']\s*\)|dataset\.(slot|component))\s*[!=]==?\s*["']([^"']+)["']/g
const attributeWrite = /(?<![[\w-])data-(slot|component)\s*=\s*["']([^"'{}]+)["']/g
const expressionWrite = /(?<![[\w-])data-(slot|component)=\{([^{}]*)\}/g
const datasetWrite = /dataset\.(slot|component)\s*=(?!=)\s*["']([^"']+)["']/g
const setAttributeWrite = /setAttribute\(\s*["']data-(slot|component)["']\s*,\s*["']([^"']+)["']/g
const stringLiteral = /["'`]([^"'`$]+)["'`]/g
const skippedFolders = new Set(["node_modules", "dist", ".git", "report", "test-results", "results"])

export function selectorsIn(text: string): Selector[] {
  const found: Selector[] = []
  for (const match of text.matchAll(bracketSelector)) found.push({ hook: hookOf(match[1]), operator: match[2] ?? "=", value: match[3] ?? "" })
  for (const match of text.matchAll(tailwindVariant)) found.push({ hook: hookOf(match[1]), operator: "=", value: match[2] ?? "" })
  return found
}

export function slotHooks(root: string): SlotHooks {
  const readers: Selector[] = []
  const writers: Record<SlotHook, Set<string>> = { "data-slot": new Set(), "data-component": new Set() }
  const write = (hook: SlotHook, value: string) => void writers[hook].add(value)
  for (const file of listed(readerFolders(root), [...codeExtensions, ...styleExtensions])) {
    const text = readFileSync(file, "utf8")
    readers.push(...selectorsIn(text))
    for (const match of text.matchAll(attributeCompare)) readers.push({ hook: hookOf(match[1] ?? match[2]), operator: "=", value: match[3] ?? "" })
  }
  for (const file of listed(writerFolders(root), codeExtensions)) {
    const text = readFileSync(file, "utf8")
    for (const pattern of [attributeWrite, datasetWrite, setAttributeWrite]) {
      for (const match of text.matchAll(pattern)) write(hookOf(match[1]), match[2] ?? "")
    }
    for (const match of text.matchAll(expressionWrite)) {
      for (const literal of (match[2] ?? "").matchAll(stringLiteral)) write(hookOf(match[1]), literal[1] ?? "")
    }
  }
  return {
    selects: (hook, value) => readers.some((selector) => selector.hook === hook && matches(selector, value)),
    written: (selector) => [...writers[selector.hook]].some((value) => matches(selector, value)),
    write,
  }
}

function hookOf(name: string | undefined): SlotHook {
  return name === "component" ? "data-component" : "data-slot"
}

function matches(selector: Selector, value: string): boolean {
  switch (selector.operator) {
    case "^=":
      return value.startsWith(selector.value)
    case "$=":
      return value.endsWith(selector.value)
    case "*=":
      return value.includes(selector.value)
    case "|=":
      return value === selector.value || value.startsWith(`${selector.value}-`)
    case "~=":
      return value.split(/\s+/).includes(selector.value)
    default:
      return value === selector.value
  }
}

function readerFolders(root: string): string[] {
  const own = [join(root, "src"), join(root, "e2e"), pluginsDirectory(root)]
  if (root !== packageRoot) return [...own, join(root, "readers")]
  return [
    ...own,
    join(repoRoot, "packages/ui/src"),
  ]
}

function writerFolders(root: string): string[] {
  const own = [join(root, "src"), pluginsDirectory(root)]
  if (root !== packageRoot) return [...own, join(root, "writers")]
  return [...own, join(repoRoot, "packages/ui/src")]
}

function listed(folders: readonly string[], extensions: readonly string[]): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skippedFolders.has(entry.name)) visit(full)
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) out.push(full)
    }
  }
  for (const folder of folders) if (existsSync(folder)) visit(folder)
  return out
}
