import { parseAgentFileContent } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"
import { desktopBridge } from "../lib/desktop-bridge"
import { isLocalPlacement } from "./placement-runtime"
import type { Server } from "./api"
import { contractMismatch } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { FileContent, FileNode, FileSearchEntries } from "./git-types"
import type { FetchQuery } from "./types"
import type { Workspaces } from "./workspaces"

const FILE_PATH = "/api/wr/file"
const SEARCH_PATH = "/api/wr/find/file"
const SEARCH_LIMIT = 50

function fileNode(row: unknown): FileNode | undefined {
  if (!isRecord(row) || typeof row.name !== "string" || typeof row.path !== "string") return undefined
  if (row.type !== "file" && row.type !== "directory") return undefined
  return { name: row.name, path: row.path, kind: row.type, ignored: row.ignored === true }
}

function fileContent(value: unknown): FileContent {
  const content = parseAgentFileContent(value)
  if (!content) throw contractMismatch("file content")
  return content
}

export function fileQueries(transport: Transport, workspaces: Workspaces) {
  const server = transport.serverUrl
  const tree = (placementId: PlacementId, path: string): FetchQuery<readonly FileNode[]> => fetchQuery(queryKeys.fileTree(server, placementId, path), async () => {
      const rows = await transport.runtimeJson(await workspaces.route(placementId), withQuery(FILE_PATH, { path }))
      if (!Array.isArray(rows)) throw contractMismatch("file tree")
      return rows.flatMap((row) => {
        const node = fileNode(row)
        return node ? [node] : []
      })
    })
  const content = (placementId: PlacementId, path: string): FetchQuery<FileContent> => fetchQuery(queryKeys.fileContent(server, placementId, path), async () =>
    fileContent(await transport.runtimeJson(await workspaces.route(placementId), withQuery(`${FILE_PATH}/content`, { path }))))
  const search = (placementId: PlacementId, query: string, entries: FileSearchEntries): FetchQuery<readonly string[]> => fetchQuery(queryKeys.fileSearch(server, placementId, query, entries), async () => {
      const rows = await transport.runtimeJson(await workspaces.route(placementId), withQuery(SEARCH_PATH, { query, limit: SEARCH_LIMIT, dirs: entries === "all" }))
      if (!Array.isArray(rows)) throw contractMismatch("file search")
      return rows.filter((row): row is string => typeof row === "string")
    })
  return { tree, content, search }
}

export function localFileContentQuery(server: Pick<Server, "placements" | "capabilities">, placementId: PlacementId, path: string): FetchQuery<FileContent> {
  const query = fetchQuery<FileContent>(queryKeys.localFileContent(placementId, path), async () => {
    const bridge = desktopBridge()
    if (!bridge || !isLocalPlacement(server.placements.byId(placementId))) {
      throw new Error("This file cannot be opened on this computer.")
    }
    return fileContent(await bridge.readFileContent(path))
  })
  return { ...query, staleTime: 0 }
}
