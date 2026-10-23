import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { workspaceInput, workspacePath, workspaceRoot, type ShellRequestContext } from "./request-context"
import { globSearch, grepSearch } from "./files"
import { machineFileIndex } from "@claxedo/workspace-runtime/file-index"
import { directoryEntries } from "@claxedo/server-core/hosts/machine/folders"

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
  // Outside the catch on purpose: it answers fs errors with `[]`, and
  // swallowing the containment 400 into that would hide a traversal probe.
  const dirPath = await workspacePath(root, c.req.query("path"))
  return await directoryEntries(root, dirPath).catch(() => [])
}

export async function allFilesBody(c: ShellRequestContext) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  const root = workspaceRoot(ws, input)
  return { paths: await machineFileIndex.list(root, { gitTimeoutMs: 1_500 }) }
}
