import fs from "fs"
import path from "path"
import { git } from "./opencode-compat-git"

const ALL_IGNORE = new Set([".git", ".DS_Store", "node_modules", ".next", "dist", "build", ".turbo", ".vercel", ".cache"])

export async function globSearch(
  searchDir: string,
  query: string,
  type: "file" | "directory" | "any",
  limit: number,
) {
  const out: string[] = []
  const q = query.trim().toLowerCase()
  const queue = [""]
  while (queue.length && out.length < limit) {
    const rel = queue.shift()!
    const abs = rel ? path.join(searchDir, rel) : searchDir
    let rows: fs.Dirent[]
    try {
      rows = (await fs.promises.readdir(abs, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))
    } catch {
      continue
    }
    for (const row of rows) {
      if (row.name === ".git" || row.name === ".DS_Store") continue
      const next = rel ? path.join(rel, row.name) : row.name
      const hit = !q || next.toLowerCase().includes(q)
      if (row.isDirectory()) {
        queue.push(next)
        if (type !== "file" && hit) out.push(next)
      }
      if (!row.isDirectory() && type !== "directory" && hit) out.push(next)
      if (out.length >= limit) break
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
