import { asArray, isString } from "@claxedo/helpers/guards"
import { readArray, readString } from "@claxedo/helpers/readers"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { freshness } from "./freshness"
import type { MachineId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { FetchQuery } from "./types"

export type FolderEntry = { readonly name: string; readonly absolute: string }

export type ServerPaths = { readonly home: string; readonly directory: string }

export type FolderPresence = "present" | "missing"

export type FolderQueries = {
  readonly paths: (machine?: MachineId) => FetchQuery<ServerPaths>
  readonly children: (directory: string, machine?: MachineId) => FetchQuery<readonly FolderEntry[]>
  readonly presence: (directory: string, machine: MachineId) => FetchQuery<FolderPresence>
}

export type FoldersApi = {
  readonly search: (scope: string, query: string, limit: number, machine?: MachineId) => Promise<readonly string[]>
}

type FolderReads = {
  readonly paths: () => Promise<ServerPaths>
  readonly children: (directory: string) => Promise<readonly FolderEntry[]>
  readonly search: (scope: string, query: string, limit: number) => Promise<readonly string[]>
}

function homeOf(body: unknown, where: string): string {
  const home = readString(body, "home")
  if (home === undefined) throw new ServerError({ class: "internal", message: `${where} answered without a home folder` })
  return home
}

function folderEntries(items: readonly unknown[], directoriesOnly: boolean): readonly FolderEntry[] {
  return items.flatMap((item) => {
    const name = readString(item, "name")
    const absolute = readString(item, "absolute")
    if (name === undefined || absolute === undefined || (directoriesOnly && readString(item, "type") !== "directory")) return []
    return [{ name, absolute }]
  })
}

function attachedReads(transport: Transport): FolderReads {
  return {
    paths: async () => {
      const body = await transport.json("/path")
      const home = homeOf(body, "The server")
      return { home, directory: readString(body, "directory") ?? home }
    },
    children: async (directory) => folderEntries(asArray(await transport.json(withQuery("/file", { directory, path: "" }))), true),
    search: async (scope, query, limit) =>
      asArray(await transport.json(withQuery("/find/file", { directory: scope, query, type: "directory", limit: String(limit) }))).filter(isString),
  }
}

function machineReads(account: HostedAccount | undefined, machine: MachineId): FolderReads {
  const read = async (body: Readonly<Record<string, unknown>>) => {
    if (!account) throw new ServerError({ class: "invalid", message: "Reading another machine's folders needs a signed-in account" })
    return await account.run("machines.folders", { enrollmentId: machine, ...body })
  }
  return {
    paths: async () => {
      const home = homeOf(await read({ read: "home" }), "The machine")
      return { home, directory: home }
    },
    children: async (directory) => folderEntries(readArray(await read({ read: "children", directory }), "folders") ?? [], false),
    search: async (scope, query, limit) => (readArray(await read({ read: "search", directory: scope, query, limit }), "folders") ?? []).filter(isString),
  }
}

export function createFolderReads(transport: Transport, account: HostedAccount | undefined) {
  return (machine: MachineId | undefined): FolderReads => (machine === undefined ? attachedReads(transport) : machineReads(account, machine))
}

async function readFolderPresence(reads: FolderReads, directory: string): Promise<FolderPresence> {
  try {
    await reads.children(directory)
    return "present"
  } catch (error) {
    if (error instanceof ServerError && error.code === "folder_not_found") return "missing"
    throw error
  }
}

export function folderQueries(transport: Transport, account: HostedAccount | undefined): FolderQueries {
  const reads = createFolderReads(transport, account)
  return {
    paths: (machine) => fetchQuery(queryKeys.folderPaths(transport.serverUrl, machine), () => reads(machine).paths()),
    children: (directory, machine) => fetchQuery(queryKeys.folderChildren(transport.serverUrl, machine, directory), () => reads(machine).children(directory)),
    presence: (directory, machine) => ({
      ...fetchQuery(queryKeys.folderPresence(transport.serverUrl, machine, directory), () => readFolderPresence(reads(machine), directory)),
      staleTime: freshness.folderPresence.ms,
    }),
  }
}

export function createFoldersApi(transport: Transport, account: HostedAccount | undefined): FoldersApi {
  const reads = createFolderReads(transport, account)
  return { search: (scope, query, limit, machine) => reads(machine).search(scope, query, limit) }
}
