import { isRecord } from "@claxedo/helpers/guards"
import { onlyStrings, readString } from "../lib/record"
import { ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { FetchQuery } from "./types"

export type FolderEntry = { readonly name: string; readonly absolute: string }

export type ServerPaths = { readonly home: string; readonly directory: string }

export type FolderQueries = {
  readonly paths: () => FetchQuery<ServerPaths>
  readonly children: (directory: string) => FetchQuery<readonly FolderEntry[]>
}

export type FoldersApi = {
  readonly search: (scope: string, query: string, limit: number) => Promise<readonly string[]>
  readonly browsable: () => Promise<boolean>
}

async function readPaths(transport: Transport): Promise<ServerPaths> {
  const body = await transport.json<unknown>("/path")
  const home = readString(body, "home")
  if (home === undefined) throw new ServerError({ class: "internal", message: "The server answered /path without a home folder" })
  return { home, directory: readString(body, "directory") ?? home }
}

async function readChildren(transport: Transport, directory: string): Promise<readonly FolderEntry[]> {
  const body = await transport.json<unknown>(withQuery("/file", { directory, path: "" }))
  return (Array.isArray(body) ? body : []).flatMap((item) => {
    const name = readString(item, "name")
    const absolute = readString(item, "absolute")
    if (name === undefined || absolute === undefined || readString(item, "type") !== "directory") return []
    return [{ name, absolute }]
  })
}

export function folderQueries(transport: Transport): FolderQueries {
  return {
    paths: () => fetchQuery(queryKeys.folderPaths(transport.serverUrl), () => readPaths(transport)),
    children: (directory) => fetchQuery(queryKeys.folderChildren(transport.serverUrl, directory), () => readChildren(transport, directory)),
  }
}

export function createFoldersApi(transport: Transport): FoldersApi {
  return {
    search: async (scope, query, limit) =>
      onlyStrings(await transport.json<unknown>(withQuery("/find/file", { directory: scope, query, type: "directory", limit: String(limit) }))),
    browsable: async () => {
      if (transport.loopback) return true
      const body = await transport.json<unknown>("/api/claxedo/health")
      return isRecord(body) && body.localExecution === true
    },
  }
}
