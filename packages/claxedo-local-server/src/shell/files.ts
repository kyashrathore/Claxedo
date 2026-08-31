import fs from "fs"
import path from "path"
import { git } from "./git"

const ALL_IGNORE = new Set([".git", ".DS_Store", "node_modules", ".next", "dist", "build", ".turbo", ".vercel", ".cache"])
const FILE_SEARCH_CACHE_MS = 10_000

const fileSearchCache = new Map<
  string,
  {
    expires: number
    index: Promise<{ files: string[]; directories: string[]; all: string[] }>
  }
>()

export async function globSearch(
  searchDir: string,
  query: string,
  type: "file" | "directory" | "any",
  limit: number,
) {
  const q = query.trim().toLowerCase()
  if (limit < 1) return []

  const root = path.resolve(searchDir)
  const cached = fileSearchCache.get(root)
  const index = cached && cached.expires > Date.now()
    ? cached.index
    : (() => {
        const next = buildFileSearchIndex(root)
        fileSearchCache.set(root, { expires: Date.now() + FILE_SEARCH_CACHE_MS, index: next })
        void next.catch(() => {
          if (fileSearchCache.get(root)?.index === next) fileSearchCache.delete(root)
        })
        return next
      })()
  const found = await index
  const paths = type === "file" ? found.files : type === "directory" ? found.directories : found.all
  return paths.filter((item) => !q || item.toLowerCase().includes(q)).slice(0, limit)
}

async function buildFileSearchIndex(root: string) {
  const files = (await gitListAll(root)) ?? (await walkAll(root))
  const directories = new Set<string>()
  files.forEach((file) => {
    const parts = file.replaceAll("\\", "/").split("/")
    parts.slice(0, -1).forEach((_, index) => directories.add(parts.slice(0, index + 1).join("/")))
  })
  const normalizedFiles = files.map((file) => file.replaceAll("\\", "/")).sort()
  const normalizedDirectories = Array.from(directories).sort()
  return {
    files: normalizedFiles,
    directories: normalizedDirectories,
    all: [...normalizedFiles, ...normalizedDirectories].sort(),
  }
}

// Text search budget. The engine backs `/find` with ripgrep; the compat layer
// has no ripgrep binary, so the pure-Node scan is bounded to keep a
// no-match pattern from reading an entire monorepo.
const GREP_MAX_FILES = 5_000
const GREP_MAX_FILE_BYTES = 1_000_000

export type GrepMatch = {
  path: { text: string }
  lines: { text: string }
  line_number: number
  absolute_offset: number
  submatches: { match: { text: string }; start: number; end: number }[]
}

// Mirrors the engine's `findText` handler (ripgrep.grep -> LegacyMatch), which
// caps results at 10 and reports 1-based line numbers with byte offsets.
export async function grepSearch(root: string, pattern: string, limit = 10): Promise<GrepMatch[]> {
  const out: GrepMatch[] = []
  if (!pattern.trim() || !root.trim() || limit < 1) return out
  let re: RegExp
  try {
    re = new RegExp(pattern, "g")
  } catch {
    return out
  }
  const files = (await gitListAll(root)) ?? (await walkAll(root))
  let scanned = 0
  for (const rel of files) {
    if (out.length >= limit || scanned >= GREP_MAX_FILES) break
    const abs = path.join(root, rel)
    let buf: Buffer
    try {
      const stat = await fs.promises.stat(abs)
      if (!stat.isFile() || stat.size > GREP_MAX_FILE_BYTES) continue
      buf = await fs.promises.readFile(abs)
    } catch {
      continue
    }
    scanned++
    if (buf.includes(0)) continue
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf)
    } catch {
      continue
    }
    let offset = 0
    let lineNumber = 0
    for (const raw of text.split("\n")) {
      lineNumber++
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
      const submatches = Array.from(line.matchAll(re)).map((hit) => ({
        match: { text: hit[0] },
        start: hit.index,
        end: hit.index + hit[0].length,
      }))
      if (submatches.length) {
        out.push({
          path: { text: rel.replaceAll("\\", "/") },
          lines: { text: line },
          line_number: lineNumber,
          absolute_offset: offset,
          submatches,
        })
        if (out.length >= limit) break
      }
      offset += Buffer.byteLength(raw, "utf-8") + 1
    }
  }
  return out
}

export async function gitListAll(root: string): Promise<string[] | undefined> {
  try {
    const tracked = await git(root, ["ls-files"])
    const untracked = await git(root, ["ls-files", "--others", "--exclude-standard"])
    const out = new Set<string>()
    for (const line of tracked.split("\n")) {
      const v = line.trim()
      if (v) out.add(v)
    }
    for (const line of untracked.split("\n")) {
      const v = line.trim()
      if (v) out.add(v)
    }
    return Array.from(out).sort()
  } catch {
    return
  }
}

export async function walkAll(root: string, limit = 200_000): Promise<string[]> {
  const out: string[] = []
  const queue = [""]
  while (queue.length && out.length < limit) {
    const rel = queue.shift()!
    const abs = rel ? path.join(root, rel) : root
    let rows: fs.Dirent[]
    try {
      rows = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const row of rows) {
      if (ALL_IGNORE.has(row.name)) continue
      // Forward slashes, matching gitListAll: both feed the same wire contract,
      // and path.join would hand Windows clients `src\todo.ts` from this branch
      // while the git branch serves `src/todo.ts`.
      const next = rel ? `${rel}/${row.name}` : row.name
      if (row.isDirectory()) {
        queue.push(next)
      } else if (row.isFile()) {
        out.push(next)
        if (out.length >= limit) break
      }
    }
  }
  return out.sort()
}

export async function fileStatus(root: string) {
  if (!root.trim()) return []
  const stat = await fs.promises.stat(root).catch(() => undefined)
  if (!stat?.isDirectory()) return []
  const dot = path.join(root, ".git")
  const has = await fs.promises.access(dot, fs.constants.F_OK).then(
    () => true,
    () => false,
  )
  if (!has) return []
  try {
    const diff = await git(root, ["diff", "--numstat", "HEAD"])
    const changed = diff
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, removed, path] = line.split("\t")
        return {
          path,
          added: added === "-" ? 0 : parseInt(added ?? "0", 10),
          removed: removed === "-" ? 0 : parseInt(removed ?? "0", 10),
          status: "modified" as const,
        }
      })

    const extra = await git(root, ["ls-files", "--others", "--exclude-standard"])
    const added = await Promise.all(
      extra
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(async (item) => {
          try {
            const text = await fs.promises.readFile(path.join(root, item), "utf-8")
            return {
              path: item,
              added: text.split("\n").length,
              removed: 0,
              status: "added" as const,
            }
          } catch {
            return
          }
        }),
    )

    const removed = await git(root, ["diff", "--name-only", "--diff-filter=D", "HEAD"])
    return [
      ...changed,
      ...added.filter((item): item is Exclude<typeof item, undefined> => !!item),
      ...removed
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((item) => ({
          path: item,
          added: 0,
          removed: 0,
          status: "deleted" as const,
        })),
    ]
  } catch {
    return []
  }
}
