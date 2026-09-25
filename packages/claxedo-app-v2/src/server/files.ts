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

function fileNode(value: unknown): FileNode | undefined {
  const row = value as { name?: unknown; path?: unknown; type?: unknown; ignored?: unknown } | null
  if (!row || typeof row.name !== "string" || typeof row.path !== "string") return undefined
  if (row.type !== "file" && row.type !== "directory") return undefined
  return { name: row.name, path: row.path, kind: row.type, ignored: row.ignored === true }
}

export function fileQueries(transport: Transport, workspaces: Workspaces) {
  const server = transport.serverUrl
  const tree = (placementId: PlacementId, path: string): FetchQuery<readonly FileNode[]> => fetchQuery(queryKeys.fileTree(server, placementId, path), async () => {
      const rows = await transport.runtimeJson<unknown[]>(await workspaces.route(placementId), withQuery(FILE_PATH, { path }))
      return rows.flatMap((row) => {
        const node = fileNode(row)
        return node ? [node] : []
      })
    })
  const content = (placementId: PlacementId, path: string): FetchQuery<FileContent> => fetchQuery(queryKeys.fileContent(server, placementId, path), async () => transport.runtimeJson<FileContent>(await workspaces.route(placementId), withQuery(`${FILE_PATH}/content`, { path })))
  const search = (placementId: PlacementId, query: string, entries: FileSearchEntries): FetchQuery<readonly string[]> => fetchQuery(queryKeys.fileSearch(server, placementId, query, entries), async () => {
      const rows = await transport.runtimeJson<unknown[]>(await workspaces.route(placementId), withQuery(SEARCH_PATH, { query, limit: SEARCH_LIMIT, dirs: entries === "all" }))
      return rows.filter((row): row is string => typeof row === "string")
    })
  return { tree, content, search }
}
