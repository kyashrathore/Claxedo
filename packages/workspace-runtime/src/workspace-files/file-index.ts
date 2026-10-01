import fs from "node:fs/promises"
import path from "node:path"
import { runGit, type GitRunOptions } from "../git"

const IGNORED_NAMES = new Set([".git", ".DS_Store", "node_modules", ".next", "dist", "build", ".turbo", ".vercel", ".cache"])

export function isFileIndexIgnoredName(name: string) {
  return IGNORED_NAMES.has(name)
}

export type FileIndexSnapshot = {
  readonly files: readonly string[]
  readonly directories: readonly string[]
  readonly all: readonly string[]
}

export type FileIndexOptions = {
  maxRoots?: number
  ttlMs?: number
  maxFiles?: number
  now?: () => number
  git?: (args: string[], cwd: string, options?: GitRunOptions) => Promise<string>
}

export type FileIndexReadOptions = {
  gitTimeoutMs?: number
}

async function walkFiles(root: string, limit: number) {
  const files: string[] = []
  const queue = [""]
  for (let head = 0; head < queue.length && files.length < limit; head += 1) {
    const relative = queue[head]!
    let rows
    try {
      rows = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    } catch {
      continue
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    for (const row of rows) {
      if (isFileIndexIgnoredName(row.name)) continue
      const next = relative ? `${relative}/${row.name}` : row.name
      if (row.isDirectory()) queue.push(next)
      else if (row.isFile()) {
        files.push(next)
        if (files.length >= limit) break
      }
    }
  }
  return files.sort()
}

export function createFileIndex(options: FileIndexOptions = {}) {
  const maxRoots = options.maxRoots ?? 32
  const ttlMs = options.ttlMs ?? 10_000
  const maxFiles = options.maxFiles ?? 200_000
  if (!Number.isSafeInteger(maxRoots) || maxRoots < 1) throw new RangeError("maxRoots must be a positive integer")
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new RangeError("maxFiles must be a positive integer")
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("ttlMs must be finite and nonnegative")
  const now = options.now ?? Date.now
  const git = options.git ?? runGit
  const cache = new Map<string, { expires: number; index: Promise<FileIndexSnapshot> }>()

  async function list(root: string, read: FileIndexReadOptions = {}) {
    const directory = path.resolve(root)
    try {
      // NUL delimiting preserves whitespace and newlines without Git's quoting.
      const output = await git(
        ["-c", "core.fsmonitor=false", "ls-files", "-c", "-o", "--exclude-standard", "-z"],
        directory,
        read.gitTimeoutMs === undefined ? undefined : { timeoutMs: read.gitTimeoutMs },
      )
      return Array.from(new Set(output.split("\0").filter(Boolean))).sort()
    } catch {
      return await walkFiles(directory, maxFiles)
    }
  }

  async function build(root: string, read: FileIndexReadOptions): Promise<FileIndexSnapshot> {
    const files = await list(root, read)
    const parents = new Set<string>()
    for (const file of files) {
      let slash = file.indexOf("/")
      while (slash >= 0) {
        parents.add(file.slice(0, slash))
        slash = file.indexOf("/", slash + 1)
      }
    }
    const directories = Array.from(parents).sort()
    return { files, directories, all: [...files, ...directories].sort() }
  }

  function get(root: string, read: FileIndexReadOptions = {}) {
    const key = path.resolve(root)
    const time = now()
    const cached = cache.get(key)
    if (cached && cached.expires > time) {
      cache.delete(key)
      cache.set(key, cached)
      return cached.index
    }
    for (const [root, entry] of cache) {
      if (entry.expires <= time) cache.delete(root)
    }
    while (cache.size >= maxRoots) cache.delete(cache.keys().next().value!)
    const index = build(key, read)
    cache.set(key, { expires: time + ttlMs, index })
    void index.catch(() => {
      if (cache.get(key)?.index === index) cache.delete(key)
    })
    return index
  }

  return {
    get,
    list,
    invalidate(root?: string) {
      if (root === undefined) cache.clear()
      else cache.delete(path.resolve(root))
    },
    get size() { return cache.size },
  }
}

export const machineFileIndex = createFileIndex()
