import fs from "fs"
import path from "path"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { workspaceInput, workspacePath, workspaceRoot, type ShellRequestContext } from "./request-context"
import { gitListAll, globSearch, grepSearch, walkAll } from "./files"

export async function findTextBody(c: ShellRequestContext) {
  const pattern = c.req.query("pattern") ?? ""
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  return grepSearch(ws?.directory ?? input.directory ?? process.cwd(), pattern)
}

export async function findFilesBody(c: ShellRequestContext) {
  const query = c.req.query("query") ?? ""
  const type = c.req.query("type") === "directory" ? "directory" : c.req.query("dirs") === "false" ? "file" : "any"
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200)
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  return globSearch(ws?.directory ?? input.directory ?? process.cwd(), query, type, limit)
}

export async function directoryEntriesBody(c: ShellRequestContext) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  const root = workspaceRoot(ws, input)
  // Outside the try on purpose: the catch below answers fs errors with `[]`, and
  // swallowing the containment 400 into that would hide a traversal probe.
  const dirPath = await workspacePath(root, c.req.query("path"))
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => ![".git", ".DS_Store"].includes(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: path.relative(root, path.join(dirPath, entry.name)),
        absolute: path.join(dirPath, entry.name),
        type: entry.isDirectory() ? "directory" : "file",
        ignored: entry.name.startsWith(".") || entry.name === "node_modules",
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  } catch {
    return []
  }
}

export async function allFilesBody(c: ShellRequestContext) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  const root = workspaceRoot(ws, input)
  const fromGit = await gitListAll(root)
  return { paths: fromGit ?? (await walkAll(root)) }
}
