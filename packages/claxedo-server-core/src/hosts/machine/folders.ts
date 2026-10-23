import fs from "node:fs/promises"
import path from "node:path"
import { isFileIndexIgnoredName } from "@claxedo/workspace-runtime/file-index"

export type DirectoryEntry = {
  name: string
  path: string
  absolute: string
  type: "directory" | "file"
  ignored: boolean
}

const HIDDEN_ENTRIES = new Set([".git", ".DS_Store"])

/** One level of `directory`, folders first, each entry's `path` relative to `root`. Throws what `readdir` throws. */
export async function directoryEntries(root: string, directory: string): Promise<DirectoryEntry[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => !HIDDEN_ENTRIES.has(entry.name))
    .map((entry): DirectoryEntry => ({
      name: entry.name,
      path: path.relative(root, path.join(directory, entry.name)),
      absolute: path.join(directory, entry.name),
      type: entry.isDirectory() ? "directory" : "file",
      ignored: entry.name.startsWith(".") || entry.name === "node_modules",
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

const SEARCH_DEPTH = 3
const SEARCH_BUDGET = 400

/**
 * Folders under `root` whose name contains `query`, as paths relative to it,
 * breadth first. A file index cannot supply empty folders, and indexing every
 * file under a home folder exceeds the picker's budget, so this walks at most
 * `SEARCH_BUDGET` folders and `SEARCH_DEPTH` levels; with no query it lists
 * one level. A folder it cannot read is skipped.
 */
export async function searchFolders(root: string, query: string, limit: number): Promise<string[]> {
  const needle = query.trim().toLowerCase()
  if (limit < 1) return []
  const base = path.resolve(root)
  const out: string[] = []
  const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }]
  const depthLimit = needle ? SEARCH_DEPTH : 1
  for (let head = 0; head < queue.length && head < SEARCH_BUDGET && out.length < limit; head += 1) {
    const { rel, depth } = queue[head]
    const rows = await fs.readdir(rel ? path.join(base, rel) : base, { withFileTypes: true }).catch(() => [])
    rows.sort((a, b) => a.name.localeCompare(b.name))
    for (const row of rows) {
      if (!row.isDirectory() || row.name.startsWith(".") || isFileIndexIgnoredName(row.name)) continue
      const next = rel ? `${rel}/${row.name}` : row.name
      if (!needle || row.name.toLowerCase().includes(needle)) {
        out.push(next)
        if (out.length >= limit) break
      }
      if (depth + 1 < depthLimit) queue.push({ rel: next, depth: depth + 1 })
    }
  }
  return out
}
