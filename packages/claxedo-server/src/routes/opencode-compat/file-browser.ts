import fs from "fs"
import path from "path"
import { resolveWorkspace } from "../../workspace/store/store"
import { workspaceInput, workspacePath, workspaceRoot, type OpenCodeCompatRequestContext } from "./context"
import { fileStatus, gitListAll, globSearch, grepSearch, walkAll } from "./files"

export async function findTextBody(c: OpenCodeCompatRequestContext) {
  const pattern = c.req.query("pattern") ?? ""
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  return grepSearch(ws?.directory ?? input.directory ?? process.cwd(), pattern)
}

export async function findFilesBody(c: OpenCodeCompatRequestContext) {
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

export async function directoryEntriesBody(c: OpenCodeCompatRequestContext) {
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

export async function fileContentBody(c: OpenCodeCompatRequestContext) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  // Outside the try for the same reason as `directoryEntriesBody`: the catch
  // returns empty content, which would mask the containment rejection.
  const full = await workspacePath(workspaceRoot(ws, input), c.req.query("path"))
  try {
    const buf = await fs.promises.readFile(full)
    if (buf.includes(0)) return binaryFileContent(buf)
    try {
      return {
        type: "text",
        content: new TextDecoder("utf-8", { fatal: true }).decode(buf).trim(),
      }
    } catch {
      return binaryFileContent(buf)
    }
  } catch {
    return {
      type: "text",
      content: "",
    }
  }
}

function binaryFileContent(content: Buffer) {
  return {
    type: "binary",
    content: content.toString("base64"),
    encoding: "base64",
  }
}

export async function fileStatusBody(c: OpenCodeCompatRequestContext) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  return fileStatus(workspaceRoot(ws, input))
}

export async function allFilesBody(c: OpenCodeCompatRequestContext) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  const root = workspaceRoot(ws, input)
  const fromGit = await gitListAll(root)
  return { paths: fromGit ?? (await walkAll(root)) }
}
