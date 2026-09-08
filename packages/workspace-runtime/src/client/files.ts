import type { AgentFileContent } from "@claxedo/agent-runtime-contract"
import { WorkspaceRuntimeRoutes } from "../routes/manifest"
import { namedMembers, type WorkspaceRuntimeCaller, type WorkspaceRuntimeRequestOptions, type WorkspaceRuntimeResponse, type WorkspaceScope } from "./request"

type Options = WorkspaceRuntimeRequestOptions
type Reply<T> = Promise<WorkspaceRuntimeResponse<T>>

export type WorkspaceFileNode = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

export type WorkspaceFileContent = AgentFileContent

export type WorkspaceFileStatus = {
  path: string
  added: number
  removed: number
  status: "added" | "deleted" | "modified"
}

export type WorkspaceFileSearchQuery = {
  query: string
  dirs?: "true" | "false"
  type?: "file" | "directory"
  limit?: number
}

export type WorkspaceFileClient = {
  list(input: WorkspaceScope & { path: string }, options?: Options): Reply<WorkspaceFileNode[]>
  read(input: WorkspaceScope & { path: string }, options?: Options): Reply<WorkspaceFileContent>
  raw(input: WorkspaceScope & { path: string }, options?: Options): Promise<Response>
  status(input?: WorkspaceScope, options?: Options): Reply<WorkspaceFileStatus[]>
  all(input?: WorkspaceScope & { path?: string }, options?: Options): Reply<{ paths: string[] }>
}

export type WorkspaceFindClient = {
  files(input: WorkspaceScope & WorkspaceFileSearchQuery, options?: Options): Reply<string[]>
}

/** The same routes as `file`/`find`, taken by path and answered with the body alone. */
export type WorkspaceFilesClient = {
  raw(path: string, options?: Options): Promise<Response>
  tree(path: string, options?: Options): Promise<WorkspaceFileNode[]>
  content(path: string, options?: Options): Promise<WorkspaceFileContent>
  status(options?: Options): Promise<WorkspaceFileStatus[]>
  list(path?: string, options?: Options): Promise<{ paths: string[] }>
  search(query: WorkspaceFileSearchQuery, options?: Options): Promise<string[]>
}

const SEARCH_QUERY = ["query", "dirs", "type", "limit"] as const

export function fileClient(caller: WorkspaceRuntimeCaller): WorkspaceFileClient {
  return {
    list: (input, options) => caller.call({ operation: "file.list", path: WorkspaceRuntimeRoutes.file, scope: input, query: { path: input.path }, options }),
    read: (input, options) => caller.call({ operation: "file.read", path: `${WorkspaceRuntimeRoutes.file}/content`, scope: input, query: { path: input.path }, options }),
    raw: async (input, options) => (await caller.send({ operation: "file.raw", path: `${WorkspaceRuntimeRoutes.file}/raw`, scope: input, query: { path: input.path }, options })).response,
    status: (input = {}, options) => caller.call({ operation: "file.status", path: `${WorkspaceRuntimeRoutes.file}/status`, scope: input, options }),
    all: (input = {}, options) => caller.call({ operation: "file.all", path: `${WorkspaceRuntimeRoutes.file}/all`, scope: input, query: namedMembers(input, ["path"]), options }),
  }
}

export function findClient(caller: WorkspaceRuntimeCaller): WorkspaceFindClient {
  return {
    files: (input, options) => caller.call({ operation: "find.files", path: WorkspaceRuntimeRoutes.fileSearch, scope: input, query: namedMembers(input, SEARCH_QUERY), options }),
  }
}

export function filesClient(file: WorkspaceFileClient, find: WorkspaceFindClient): WorkspaceFilesClient {
  return {
    raw: (path, options) => file.raw({ path }, options),
    tree: async (path, options) => (await file.list({ path }, options)).data,
    content: async (path, options) => (await file.read({ path }, options)).data,
    status: async (options) => (await file.status({}, options)).data,
    list: async (path, options) => (await file.all({ path }, options)).data,
    search: async (query, options) => (await find.files(query, options)).data,
  }
}
