import fs from "fs"
import path from "path"
import fuzzysort from "fuzzysort"
import { runGit } from "../git"
import { resolveWorkspacePath } from "../target"

export type WorkspaceFileKind = "file" | "directory" | "any"

export async function resolveWorkspaceFile(root: string, input?: string) {
  return await resolveWorkspacePath(root, input)
}

export async function searchWorkspaceFiles(
  searchDir: string,
  query: string,
  type: WorkspaceFileKind,
  limit: number,
) {
  if (limit < 1) return []
  const index = await workspaceSearchIndex(searchDir)
  const items = type === "file" ? index.files : type === "directory" ? index.directories : index.all
  const q = query.trim()
  if (!q) return items.slice(0, limit)
  return fuzzysort.go(q, items, { limit }).map((hit) => hit.target)
}

export async function listWorkspaceDirectory(root: string, dir: string) {
  const exclude = new Set([".git", ".DS_Store"])
  const rows = await fs.promises.readdir(dir, { withFileTypes: true })
  return rows
    .filter((item) => !exclude.has(item.name))
    .map((item) => ({
      name: item.name,
      path: path.relative(root, path.join(dir, item.name)),
      absolute: path.join(dir, item.name),
      type: item.isDirectory() ? "directory" as const : "file" as const,
      ignored: item.name.startsWith(".") || item.name === "node_modules",
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
}

export async function readWorkspaceFileContent(file: string) {
  try {
    const buf = await fs.promises.readFile(file)
    // A NUL byte is a reliable binary marker (images, archives) that a fatal
    // UTF-8 decode also rejects; check it first so we don't waste a decode.
    if (!buf.includes(0)) {
      try {
        return {
          type: "text" as const,
          content: new TextDecoder("utf-8", { fatal: true }).decode(buf).trim(),
        }
      } catch {
        // Falls through to the binary branch below.
      }
    }
    // Binary: carry the actual bytes as base64 so the client can preview
    // images inline. Returning empty content here left PNG/JPG previews blank
    // while SVG (valid UTF-8 text) rendered fine.
    const extension = file.split(".").pop()?.toLowerCase() ?? ""
    return {
      type: "binary" as const,
      content: buf.toString("base64"),
      encoding: "base64" as const,
      mimeType: IMAGE_MIME_BY_EXTENSION[extension],
    }
  } catch {
    return {
      type: "text" as const,
      content: "",
    }
  }
}

export async function workspaceRawFile(file: string) {
  const stat = await fs.promises.stat(file)
  if (!stat.isFile()) return undefined
  return {
    size: stat.size,
    stream: fs.createReadStream(file),
  }
}

async function gitCmd(root: string, args: string[]) {
  return await runGit(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args], root)
}

export async function workspaceFileStatus(root: string) {
  try {
    const diff = await gitCmd(root, ["diff", "--numstat", "HEAD", "--"])
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

    const extra = await gitCmd(root, ["ls-files", "--others", "--exclude-standard"])
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
            return undefined
          }
        }),
    )

    const removed = await gitCmd(root, ["diff", "--name-only", "--diff-filter=D", "HEAD", "--"])
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

const ALL_IGNORE = new Set([".git", ".DS_Store", "node_modules", ".next", "dist", "build", ".turbo", ".vercel", ".cache"])

async function gitListAll(root: string): Promise<string[] | undefined> {
  try {
    // `-c -o` in one pass: tracked plus not-ignored-untracked. Two spawns
    // produced a byte-identical union and doubled the cost of the only step
    // a cold file search waits on.
    const listed = await gitCmd(root, ["ls-files", "-c", "-o", "--exclude-standard"])
    const out = new Set<string>()
    for (const line of listed.split("\n")) {
      const v = line.trim()
      if (v) out.add(v)
    }
    return Array.from(out).sort()
  } catch {
    return undefined
  }
}

async function walkAll(root: string, limit = 200_000): Promise<string[]> {
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
      const next = rel ? path.join(rel, row.name) : row.name
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

export async function listAllWorkspaceFiles(root: string) {
  return await gitListAll(root) ?? await walkAll(root)
}

const SEARCH_INDEX_TTL_MS = 10_000

type WorkspaceSearchIndex = {
  readonly files: readonly string[]
  readonly directories: readonly string[]
  readonly all: readonly string[]
}

const searchIndexes = new Map<string, { expires: number; index: Promise<WorkspaceSearchIndex> }>()

/** Builds the index off the request path, so the first search matches in memory. */
export function warmWorkspaceSearchIndex(root: string) {
  void workspaceSearchIndex(root).catch(() => {})
}

/**
 * Searching matches against this prebuilt list instead of walking the tree per
 * keystroke. The walk it replaced only stopped once it filled `limit`, so any
 * query with fewer hits than that read every directory in the workspace —
 * 130,479 of them and 13.6s on this monorepo, once per character typed.
 * Listing costs 37ms and a query against the result stays under 3ms.
 */
function workspaceSearchIndex(root: string) {
  const key = path.resolve(root)
  const cached = searchIndexes.get(key)
  if (cached && cached.expires > Date.now()) return cached.index

  const index = buildWorkspaceSearchIndex(key)
  searchIndexes.set(key, { expires: Date.now() + SEARCH_INDEX_TTL_MS, index })
  // A rejected build must not be served for the rest of the window.
  void index.catch(() => {
    if (searchIndexes.get(key)?.index === index) searchIndexes.delete(key)
  })
  return index
}

async function buildWorkspaceSearchIndex(root: string): Promise<WorkspaceSearchIndex> {
  const listed = await listAllWorkspaceFiles(root)
  const files = listed.map((item) => item.replaceAll("\\", "/")).sort()

  const directories = new Set<string>()
  for (const file of files) {
    const parts = file.split("/")
    for (const [index] of parts.slice(0, -1).entries()) {
      directories.add(parts.slice(0, index + 1).join("/"))
    }
  }

  const sortedDirectories = Array.from(directories).sort()
  return {
    files,
    directories: sortedDirectories,
    all: [...files, ...sortedDirectories].sort(),
  }
}
