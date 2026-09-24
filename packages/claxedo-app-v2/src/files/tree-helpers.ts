import type { FileNode } from "@/server"
import { basename, parentPath } from "./path"
import type { TreeSource } from "./tree-source"

export type FileTreeFilter = {
  readonly files: ReadonlySet<string>
  readonly dirs: ReadonlySet<string>
}

export function dirsToExpand(input: {
  readonly level: number
  readonly filter?: { readonly dirs: ReadonlySet<string> }
  readonly expanded: (dir: string) => boolean
}): string[] {
  if (input.level !== 0 || !input.filter) return []
  return [...input.filter.dirs].filter((dir) => !input.expanded(dir))
}

export function buildAllowedFilter(allowed: readonly string[]): FileTreeFilter {
  const files = new Set(allowed)
  const dirs = new Set<string>()
  for (const item of allowed) {
    const parents = item.split("/").slice(0, -1)
    for (const [index] of parents.entries()) {
      const dir = parents.slice(0, index + 1).join("/")
      if (dir) dirs.add(dir)
    }
  }
  return { files, dirs }
}

export function fileTreeRevealWindow(input: {
  readonly paths: readonly string[]
  readonly active: string | undefined
  readonly batchSize: number
  readonly batchesBefore: number
  readonly batchesAfter: number
}): { readonly start: number; readonly end: number } {
  if (!Number.isFinite(input.batchSize) || input.batchSize <= 0) {
    return { start: 0, end: input.paths.length }
  }
  const active = input.active
  const index = active ? input.paths.findIndex((path) => active === path || active.startsWith(`${path}/`)) : -1
  const anchored = index === -1 ? 0 : Math.floor(index / input.batchSize) * input.batchSize
  const start = Math.max(0, anchored - input.batchesBefore * input.batchSize)
  const end = Math.min(input.paths.length, anchored + (1 + input.batchesAfter) * input.batchSize)
  return { start, end }
}

export type TreeKeyAction =
  { readonly kind: "focus"; readonly index: number } | { readonly kind: "toggle" } | { readonly kind: "none" }

export function resolveTreeKeyAction(input: {
  readonly key: string
  readonly index: number
  readonly count: number
  readonly expanded: boolean | undefined
}): TreeKeyAction {
  const { key, index, count } = input
  if (count === 0) return { kind: "none" }
  const clamp = (value: number) => Math.max(0, Math.min(count - 1, value))
  switch (key) {
    case "ArrowDown":
      return { kind: "focus", index: clamp(index + 1) }
    case "ArrowUp":
      return { kind: "focus", index: clamp(index - 1) }
    case "Home":
      return { kind: "focus", index: 0 }
    case "End":
      return { kind: "focus", index: count - 1 }
    case "ArrowRight":
      if (input.expanded === false) return { kind: "toggle" }
      if (input.expanded === true) return { kind: "focus", index: clamp(index + 1) }
      return { kind: "none" }
    case "ArrowLeft":
      if (input.expanded === true) return { kind: "toggle" }
      return { kind: "focus", index: clamp(index - 1) }
    default:
      return { kind: "none" }
  }
}

export const treeKey = (path: string) => path.replace(/[\\/]+$/, "").replaceAll("\\", "/")

export function expandedDepths(source: TreeSource, root: string, level: number): ReadonlyMap<string, number> {
  const out = new Map<string, number>()
  if (!source.state(root).expanded) return out
  const seen = new Set<string>()
  const stack: { dir: string; lvl: number; i: number; kids: string[]; max: number }[] = []
  const push = (dir: string, lvl: number) => {
    if (seen.has(treeKey(dir))) return
    seen.add(treeKey(dir))
    const kids = source
      .children(dir)
      .filter((node) => node.kind === "directory" && source.state(node.path).expanded)
      .map((node) => node.path)
    stack.push({ dir, lvl, i: 0, kids, max: lvl })
  }
  push(root, level - 1)
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    if (top.i < top.kids.length) {
      push(top.kids[top.i]!, top.lvl + 1)
      top.i++
      continue
    }
    out.set(top.dir, top.max)
    stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.max = Math.max(parent.max, top.max)
  }
  return out
}

export function filteredNodes(
  source: TreeSource,
  path: string,
  filter: FileTreeFilter | undefined,
): readonly FileNode[] {
  const nodes = source.children(path)
  if (!filter) return nodes
  const out = nodes.filter((node) => (node.kind === "file" ? filter.files.has(node.path) : filter.dirs.has(node.path)))
  const seen = new Set(out.map((node) => node.path))
  const add = (item: string, kind: FileNode["kind"]) => {
    if (parentPath(item) !== path || seen.has(item)) return
    out.push({ name: basename(item), path: item, kind, ignored: false })
    seen.add(item)
  }
  for (const dir of filter.dirs) add(dir, "directory")
  for (const item of filter.files) add(item, "file")
  return out.sort((a, b) => (a.kind !== b.kind ? (a.kind === "directory" ? -1 : 1) : a.name.localeCompare(b.name)))
}
