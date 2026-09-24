import { isRecord, onlyStrings, readString } from "../lib/record"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery } from "./types"

export type EngineProjectIcon = { readonly url?: string; readonly override?: string; readonly color?: string }

export type EngineWorkspace = {
  readonly id?: string
  readonly workspaceId?: string
  readonly directory?: string
  readonly kind?: string
  readonly status?: string
}

export type EngineProject = {
  readonly id: string
  readonly worktree: string
  readonly name?: string
  readonly kind?: string
  readonly icon?: EngineProjectIcon
  readonly commands?: { readonly start?: string }
  readonly sandboxes: readonly string[]
  readonly git?: { readonly remote?: string | null }
  readonly workspaces: Readonly<Record<string, EngineWorkspace>>
}

export type EngineProjectUpdate = {
  readonly id: string
  readonly worktree: string
  readonly name?: string
  readonly icon?: EngineProjectIcon
  readonly commands?: { readonly start?: string }
}

export type EngineProjectsQueries = { readonly list: () => FetchQuery<readonly EngineProject[]> }

export type EngineProjectsApi = { readonly update: (input: EngineProjectUpdate) => Promise<void> }

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function iconOf(value: unknown): EngineProjectIcon | undefined {
  if (!isRecord(value)) return undefined
  return defined({ url: readString(value, "url"), override: readString(value, "override"), color: readString(value, "color") })
}

function workspacesOf(value: unknown): Record<string, EngineWorkspace> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, row]) => {
      if (!isRecord(row)) return []
      const entry = defined({
        id: readString(row, "id"),
        workspaceId: readString(row, "workspaceId") ?? readString(row, "workspace_id"),
        directory: readString(row, "directory"),
        kind: readString(row, "kind"),
        status: readString(row, "status"),
      })
      return [[key, entry]]
    }),
  )
}

function projectOf(row: unknown): EngineProject[] {
  const id = readString(row, "id")
  const worktree = readString(row, "worktree")
  if (!isRecord(row) || id === undefined || worktree === undefined) return []
  const start = isRecord(row.commands) ? readString(row.commands, "start") : undefined
  const remote = isRecord(row.git) ? row.git.remote : undefined
  return [{
    id,
    worktree,
    ...defined({ name: readString(row, "name"), kind: readString(row, "kind"), icon: iconOf(row.icon) }),
    ...(start === undefined ? {} : { commands: { start } }),
    sandboxes: onlyStrings(row.sandboxes),
    ...(typeof remote === "string" || remote === null ? { git: { remote } } : {}),
    workspaces: workspacesOf(row.workspaces),
  }]
}

export function engineProjectQueries(transport: Transport): EngineProjectsQueries {
  return {
    list: () => fetchQuery(queryKeys.engineProjects(transport.serverUrl), async () => {
      const body = await transport.json<unknown>("/project")
      return (Array.isArray(body) ? body : []).flatMap(projectOf)
    }),
  }
}

export function createEngineProjectsApi(transport: Transport): EngineProjectsApi {
  return {
    update: async (input) => {
      const path = `/project/${encodeURIComponent(input.id)}?${new URLSearchParams({ directory: input.worktree }).toString()}`
      const body = defined({ name: input.name, icon: input.icon, commands: input.commands })
      await transport.json<unknown>(path, jsonInit("PATCH", body))
    },
  }
}
