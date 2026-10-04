import fs from "fs"
import path from "path"
import fuzzysort from "fuzzysort"
import { runGit } from "../git"
import { resolveWorkspacePath } from "../target"
import { readWorkingTreeText } from "./working-tree"
import { machineFileIndex } from "@claxedo/workspace-runtime/file-index"

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
  const index = await machineFileIndex.get(searchDir)
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
          const text = await readWorkingTreeText({ directory: root, file: item })
          if (text === undefined) return undefined
          return {
            path: item,
            added: text.split("\n").length,
            removed: 0,
            status: "added" as const,
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

export async function listAllWorkspaceFiles(root: string) {
  return await machineFileIndex.list(root)
}

export function warmWorkspaceSearchIndex(root: string) {
  void machineFileIndex.get(root).catch(() => {})
}
