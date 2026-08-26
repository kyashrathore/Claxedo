/**
 * Pure logic for the recursive file tree, split out of file-tree.tsx so the
 * "when do we fetch a directory's children", "which ancestor dirs must be
 * expanded to reveal the allowed set", and the allowed-set → {files,dirs}
 * derivation are testable without mounting the SolidJS component.
 */

export type FileTreeFilter = {
  readonly files: Set<string>
  readonly dirs: Set<string>
}

/**
 * Whether the ROOT level should trigger an initial `list()` — only at level 0,
 * and only when the directory hasn't already loaded or started loading.
 */
export function shouldListRoot(input: { level: number; dir?: { loaded?: boolean; loading?: boolean } }): boolean {
  if (input.level !== 0) return false
  if (input.dir?.loaded) return false
  if (input.dir?.loading) return false
  return true
}

/**
 * Whether a NESTED (non-root) expanded directory should trigger a `list()` —
 * only when expanded and not already loaded/loading.
 */
export function shouldListExpanded(input: {
  level: number
  dir?: { expanded?: boolean; loaded?: boolean; loading?: boolean }
}): boolean {
  if (input.level === 0) return false
  if (!input.dir?.expanded) return false
  if (input.dir.loaded) return false
  if (input.dir.loading) return false
  return true
}

/**
 * The ancestor directories (from the active filter) that are not yet expanded,
 * so a caller can expand them to reveal the filtered results. Only meaningful at
 * the root level.
 */
export function dirsToExpand(input: {
  level: number
  filter?: { dirs: Set<string> }
  expanded: (dir: string) => boolean
}): string[] {
  if (input.level !== 0) return []
  if (!input.filter) return []
  return [...input.filter.dirs].filter((dir) => !input.expanded(dir))
}

/**
 * Derives the {files, dirs} filter from an allowed path list: every allowed path
 * is a file, and every prefix directory along each path is collected so the tree
 * can walk down to the allowed files.
 */
export function buildAllowedFilter(allowed: readonly string[]): FileTreeFilter {
  const files = new Set(allowed)
  const dirs = new Set<string>()

  for (const item of allowed) {
    const parts = item.split("/")
    const parents = parts.slice(0, -1)
    for (const [idx] of parents.entries()) {
      const dir = parents.slice(0, idx + 1).join("/")
      if (dir) dirs.add(dir)
    }
  }

  return { files, dirs }
}

/** The parent directory of a "/"-separated path ("" if it has no separator). */
export function parentPath(path: string): string {
  const idx = path.lastIndexOf("/")
  if (idx === -1) return ""
  return path.slice(0, idx)
}

/** The final segment (leaf name) of a "/"-separated path. */
export function leafName(path: string): string {
  const idx = path.lastIndexOf("/")
  return idx === -1 ? path : path.slice(idx + 1)
}

/**
 * The half-open row range one tree level materializes.
 *
 * A directory can hold hundreds of entries, and the row that has to be on
 * screen is the active path's — which may sit anywhere in it. Materializing
 * every row from the top down to that one makes a level's DOM proportional to
 * the directory rather than to what is read: revealing the 357th entry of the
 * heavy-workspace corpus built 360 rows inside the single task that landed the
 * listing, and that task's row construction plus the whole-document style
 * recalc its subtree forced was the largest task of a workspace reopen.
 *
 * So the window is one batch wide and starts at the batch holding the active
 * path; the rows on either side stay reachable through the "show more"
 * affordances, which widen it a batch at a time. Without a batch size (no
 * `visibleLimit`) the level is not batched at all and the window is the whole
 * directory.
 */
export function fileTreeRevealWindow(input: {
  paths: readonly string[]
  active: string | undefined
  batchSize: number
  batchesBefore: number
  batchesAfter: number
}): { start: number; end: number } {
  if (!Number.isFinite(input.batchSize) || input.batchSize <= 0) {
    return { start: 0, end: input.paths.length }
  }
  const active = input.active
  const index = active
    ? input.paths.findIndex((path) => active === path || active.startsWith(`${path}/`))
    : -1
  const anchored = index === -1 ? 0 : Math.floor(index / input.batchSize) * input.batchSize
  const start = Math.max(0, anchored - input.batchesBefore * input.batchSize)
  const end = Math.min(input.paths.length, anchored + (1 + input.batchesAfter) * input.batchSize)
  return { start, end }
}

export type TreeKeyAction =
  { readonly kind: "focus"; readonly index: number } | { readonly kind: "toggle" } | { readonly kind: "none" }

/**
 * WAI-ARIA tree keyboard model, expressed as a pure decision over the focused
 * treeitem's position and expanded state so the DOM handler in file-tree.tsx is
 * a thin adapter:
 *   - Up/Down move focus between visible treeitems (clamped at the ends);
 *   - Home/End jump to the first/last;
 *   - Right expands a collapsed directory, else moves to the next item;
 *   - Left collapses an expanded directory, else moves to the previous item.
 * `expanded` is true/false for a directory row and undefined for a file row.
 */
export function resolveTreeKeyAction(input: {
  key: string
  index: number
  count: number
  expanded: boolean | undefined
}): TreeKeyAction {
  const { key, index, count } = input
  if (count === 0) return { kind: "none" }
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i))
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
