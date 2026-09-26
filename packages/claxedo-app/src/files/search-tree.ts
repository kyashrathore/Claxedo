import type { FileNode } from "@/server"
import { sortNodes } from "./model"
import { basename, parentPath } from "./path"
import type { TreeSource } from "./tree-source"

export type SearchTree = {
  readonly nodes: ReadonlyMap<string, FileNode>
  readonly dirs: ReadonlySet<string>
  readonly children: ReadonlyMap<string, readonly FileNode[]>
}

export function samePaths(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  const members = new Set(a)
  return new Set(b).size === members.size && b.every((path) => members.has(path))
}

export function buildSearchTree(paths: readonly string[], previous: SearchTree | undefined): SearchTree {
  const nodes = new Map<string, FileNode>()
  const add = (path: string, kind: FileNode["kind"]) => {
    if (!path || nodes.has(path)) return
    const known = previous?.nodes.get(path)
    nodes.set(path, known?.kind === kind ? known : { name: basename(path), path, kind, ignored: false })
  }
  for (const path of paths) {
    add(path, "file")
    for (let dir = parentPath(path); dir; dir = parentPath(dir)) add(dir, "directory")
  }
  const grouped = new Map<string, FileNode[]>()
  for (const node of nodes.values()) {
    const parent = parentPath(node.path)
    const members = grouped.get(parent)
    if (members) members.push(node)
    else grouped.set(parent, [node])
  }
  const children = new Map([...grouped].map(([dir, members]) => [dir, sortNodes(members)] as const))
  const dirs = new Set([...nodes.values()].filter((node) => node.kind === "directory").map((node) => node.path))
  return { nodes, dirs, children }
}

export function createSearchSource(listing: TreeSource, tree: SearchTree): TreeSource {
  const listed = (dir: string) => {
    if (!listing.state(dir).loaded) return undefined
    return new Map(listing.children(dir).map((node) => [node.path, node]))
  }
  return {
    children: (dir) => {
      const members = tree.children.get(dir) ?? []
      const known = listed(dir)
      return known ? members.map((node) => known.get(node.path) ?? node) : members
    },
    state: (dir) => ({
      expanded: listing.state(dir).expanded,
      loaded: true,
      loading: false,
      error: undefined,
      retry: () => undefined,
    }),
    expand: listing.expand,
    collapse: listing.collapse,
  }
}
