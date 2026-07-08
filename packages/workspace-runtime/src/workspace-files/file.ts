import fs from "fs"
import path from "path"
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

export async function readWorkspaceFileContent(file: string) {
  try {
    const buf = await fs.promises.readFile(file)
    try {
      return {
        type: "text" as const,
        content: new TextDecoder("utf-8", { fatal: true }).decode(buf).trim(),
      }
    } catch {
      return {
        type: "binary" as const,
        content: "",
      }
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
  if (!stat.isFile()) return
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
            return
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
    const tracked = await gitCmd(root, ["ls-files"])
    const untracked = await gitCmd(root, ["ls-files", "--others", "--exclude-standard"])
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
