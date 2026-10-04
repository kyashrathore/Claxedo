import type { AppError, FileNode } from "@/server"
import { fileTreeRevealWindow, treeKey } from "./tree-helpers"
import type { TreeSource } from "./tree-source"

export const MAX_TREE_DEPTH = 128

export type RevealBatches = { readonly before: number; readonly after: number }

export type TreeRow =
  | { readonly kind: "node"; readonly key: string; readonly node: FileNode; readonly level: number }
  | { readonly kind: "more"; readonly key: string; readonly dir: string; readonly side: "before" | "after"; readonly count: number }
  | { readonly kind: "loading"; readonly key: string; readonly level: number }
  | { readonly kind: "failed"; readonly key: string; readonly error: AppError; readonly retry: () => void }
  | { readonly kind: "cycle"; readonly key: string }

export type TreeRowsInput = {
  readonly source: TreeSource
  readonly active: string | undefined
  readonly batchSize: number
  readonly batches: (dir: string) => RevealBatches
}

function levelRows(input: TreeRowsInput, dir: string, level: number, chain: ReadonlySet<string>, out: TreeRow[]): void {
  const state = input.source.state(dir)
  const nodes = input.source.children(dir)
  if (state.error) out.push({ kind: "failed", key: `failed:${dir}`, error: state.error, retry: state.retry })
  else if (state.loading && nodes.length === 0) out.push({ kind: "loading", key: `loading:${dir}`, level })
  const batches = input.batches(dir)
  const window = fileTreeRevealWindow({
    paths: nodes.map((node) => node.path),
    active: input.active,
    batchSize: input.batchSize,
    batchesBefore: batches.before,
    batchesAfter: batches.after,
  })
  if (window.start > 0) out.push({ kind: "more", key: `more-before:${dir}`, dir, side: "before", count: Math.min(window.start, input.batchSize) })
  for (const node of nodes.slice(window.start, window.end)) {
    out.push({ kind: "node", key: node.path, node, level })
    if (node.kind !== "directory" || !input.source.state(node.path).expanded) continue
    if (level + 1 >= MAX_TREE_DEPTH || chain.has(treeKey(node.path))) out.push({ kind: "cycle", key: `cycle:${node.path}` })
    else levelRows(input, node.path, level + 1, new Set([...chain, treeKey(node.path)]), out)
  }
  const hiddenAfter = nodes.length - window.end
  if (hiddenAfter > 0) out.push({ kind: "more", key: `more-after:${dir}`, dir, side: "after", count: Math.min(hiddenAfter, input.batchSize) })
}

export function treeRows(input: TreeRowsInput): readonly TreeRow[] {
  const out: TreeRow[] = []
  levelRows(input, "", 0, new Set([treeKey("")]), out)
  return out
}
