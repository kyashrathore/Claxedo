import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { codeExtensions, packageRoot, pluginsDirectory, repoRoot, styleExtensions } from "./files"

export type SlotHook = "data-slot" | "data-component"

type Selector = { readonly operator: string; readonly value: string }

export type SlotReaders = { readonly selects: (hook: SlotHook, value: string) => boolean }

const bracketSelector = /\[\s*data-(slot|component)\s*([~|^$*]?=)\s*["']?([^"'\]\s]+)["']?\s*\]/g
const tailwindVariant = /data-\[(slot|component)=([^\]]+)\]/g
const skippedFolders = new Set(["node_modules", "dist", ".git", "legacy", "report", "test-results", "results"])

export function slotReaders(root: string): SlotReaders {
  const selectors: Record<SlotHook, Selector[]> = { "data-slot": [], "data-component": [] }
  for (const file of readerFiles(root)) {
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(bracketSelector)) {
      selectors[`data-${match[1]}` as SlotHook].push({ operator: match[2] ?? "=", value: match[3] ?? "" })
    }
    for (const match of text.matchAll(tailwindVariant)) {
      selectors[`data-${match[1]}` as SlotHook].push({ operator: "=", value: match[2] ?? "" })
    }
  }
  return { selects: (hook, value) => selectors[hook].some((selector) => matches(selector, value)) }
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
    join(repoRoot, "packages/session-ui/src"),
    join(repoRoot, "packages/claxedo-app/perf-harness"),
  ]
}

function readerFiles(root: string): string[] {
  const extensions = [...codeExtensions, ...styleExtensions]
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skippedFolders.has(entry.name)) visit(full)
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) out.push(full)
    }
  }
  for (const folder of readerFolders(root)) if (existsSync(folder)) visit(folder)
  return out
}
