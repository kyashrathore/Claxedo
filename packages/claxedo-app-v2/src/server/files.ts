import type { AgentFileContent } from "@claxedo/agent-runtime-contract"
import { queryOptions } from "@tanstack/solid-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { Workspaces } from "./workspaces"

export type FileNode = {
  readonly name: string
  readonly path: string
  readonly absolute: string
  readonly type: "file" | "directory"
  readonly ignored: boolean
}

export type FileContent = AgentFileContent

export type FileStatus = {
  readonly path: string
  readonly added: number
  readonly removed: number
  readonly status: "added" | "deleted" | "modified"
}

const FILE_PATH = "/api/wr/file"

function isFileNode(value: unknown): value is FileNode {
  const row = value as Partial<FileNode> | null
  return !!row && typeof row.name === "string" && typeof row.path === "string" && (row.type === "file" || row.type === "directory")
}

function isFileStatus(value: unknown): value is FileStatus {
  const row = value as Partial<FileStatus> | null
  return !!row && typeof row.path === "string" && typeof row.added === "number" && typeof row.removed === "number"
}

export function fileQueries(transport: Transport, workspaces: Workspaces) {
  const server = transport.serverUrl
  return {
    tree: (placementId: PlacementId, path: string) => queryOptions({
      queryKey: queryKeys.fileTree(server, placementId, path),
      queryFn: async () => {
        const rows = await transport.runtimeJson<unknown[]>(workspaces.routeFor(placementId), withQuery(FILE_PATH, { path }))
        return rows.filter(isFileNode)
      },
    }),
    content: (placementId: PlacementId, path: string) => queryOptions({
      queryKey: queryKeys.fileContent(server, placementId, path),
      queryFn: () => transport.runtimeJson<FileContent>(workspaces.routeFor(placementId), withQuery(`${FILE_PATH}/content`, { path })),
    }),
    status: (placementId: PlacementId) => queryOptions({
      queryKey: queryKeys.fileStatus(server, placementId),
      queryFn: async () => {
        const rows = await transport.runtimeJson<unknown[]>(workspaces.routeFor(placementId), `${FILE_PATH}/status`)
        return rows.filter(isFileStatus)
      },
    }),
  }
}
