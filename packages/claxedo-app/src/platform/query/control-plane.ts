import type { Command, Project, ProviderAuthResponse, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { cmp } from "@/platform/query/sort"
import { mergeProviderIndexWithDetails, normalizeProviderList } from "@/platform/query/provider-list"

export type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"

type ProjectClient = {
  project: {
    list: () => Promise<{ data?: Project[] }>
  }
}

type ProviderClient = {
  provider: {
    list: () => Promise<{ data?: ProviderListResponse }>
  }
}

type CommandClient = {
  command: {
    list: () => Promise<{ data?: Command[] }>
  }
}

export function createHttpShellBackend(input: {
  client: Partial<ProjectClient & ProviderClient & CommandClient>
}) {
  return {
    listProjects: async () => {
      if (!input.client.project) throw new Error("shell backend requires project client")
      return (await input.client.project.list()).data
    },
    listProviders: async () => {
      if (!input.client.provider) throw new Error("shell backend requires provider client")
      return (await input.client.provider.list()).data
    },
    listCommands: async (_input: { directory: string }) => {
      if (!input.client.command) throw new Error("shell backend requires command client")
      return (await input.client.command.list()).data
    },
  }
}

type ProviderAuthClient = {
  provider: {
    auth: () => Promise<{ data?: ProviderAuthResponse }>
  }
}

/**
 * A stable empty catalog. Consumers memoise per catalog ARRAY IDENTITY
 * (`signedWorkspaceFromProjects`'s WeakMap), so handing out a fresh `[]` on
 * every miss would defeat that memo and leak one map entry per call.
 */
const EMPTY_CATALOG: Project[] = []

/**
 * The project/workspace catalog this app has already resolved, read from its
 * cache.
 *
 * The single reader of `queryKeys.controlPlane.projects`. It is what makes
 * "which workspace is this, and what kind" answerable WITHOUT every caller
 * threading an inventory down to whoever asks: a guess about a local
 * workspace's kind is not a smaller answer than the catalog's, it is a
 * different one.
 *
 * `baseUrl` is part of the identity, not a convenience: the key is per-server,
 * so reading it with the wrong one answers an empty catalog rather than a
 * wrong row.
 */
export function readProjectCatalog(baseUrl: string | undefined): Project[] {
  return queryClient.getQueryData<Project[]>(queryKeys.controlPlane.projects(baseUrl)) ?? EMPTY_CATALOG
}

export function normalizeProjectList(data: Project[] | undefined) {
  return (data ?? [])
    .filter((item) => !!item?.id)
    .filter((item) => !!item.worktree)
    .slice()
    .sort((a, b) => cmp(a.id, b.id))
}

/**
 * Whether the cached project catalog still lacks a control-plane project for
 * `directory`.
 *
 * A workspace is only registered in the claxedo workspace store when a
 * directory-scoped request first touches it, so global bootstrap can win the
 * race and seed this query from the embedded OpenCode engine instead — that
 * payload carries `{ id: <engine hash>, worktree, vcs }` with no `name` and no
 * `workspaces`. It looks like a hit on `worktree` alone, which is why the check
 * is on `workspaces`: the rail then labels the project from the worktree
 * basename and, because the engine's hashed `id` never matches the workspace
 * uuid the session inventory groups by, shows no sessions. `staleTime` freezes
 * that payload for five minutes, so it only heals when something invalidates
 * the query.
 */
export function projectCatalogMissingWorkspace(
  projects: Array<Project & { workspaces?: Record<string, unknown> }> | undefined,
  worktree: string,
) {
  if (!worktree) return false
  return !(projects ?? []).some(
    (project) =>
      project.worktree === worktree && Object.keys(project.workspaces ?? {}).length > 0,
  )
}

export function projectListQuery(input: {
  baseUrl?: string
  client: ProjectClient
}) {
  const backend = createHttpShellBackend({
    client: input.client,
  })
  return {
    queryKey: queryKeys.controlPlane.projects(input.baseUrl),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => normalizeProjectList(await backend.listProjects()),
  }
}

export function providerListQuery(input: {
  baseUrl?: string
  client: ProviderClient
  directory?: string | null
  harnessType: string
  request?: typeof fetch
}) {
  const backend = createHttpShellBackend({
    client: input.client,
  })
  return {
    queryKey: queryKeys.controlPlane.providers(
      input.baseUrl,
      input.directory ?? undefined,
      input.harnessType,
    ),
    staleTime: 5 * 60 * 1000,
    // Provider discovery is a read-only startup dependency and may race the
    // local runtime becoming ready. Retry this query explicitly instead of
    // inheriting the app-wide `retry: false`; a failure still reaches an error
    // state after the bounded attempts and is never cached as an empty list.
    retry: 2,
    retryDelay: 250,
    structuralSharing: (previous: unknown, index: unknown) => mergeProviderIndexWithDetails(
      previous as Parameters<typeof mergeProviderIndexWithDetails>[0],
      index as Parameters<typeof mergeProviderIndexWithDetails>[1],
    ),
    queryFn: async () => {
      if (!input.baseUrl || !input.request) {
        return normalizeProviderList((await backend.listProviders()) ?? { all: [], connected: [], default: {} })
      }
      const url = new URL("/provider", input.baseUrl)
      url.searchParams.set("harness", input.harnessType)
      if (input.directory) url.searchParams.set("directory", input.directory)
      const response = await input.request(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error((await response.text()) || `Failed to load ${input.harnessType} models`)
      return normalizeProviderList(await response.json() as ProviderListResponse)
    },
  }
}

/**
 * Which credentials a harness holds, on the machine that serves this scope.
 *
 * Auth is the machine's, not the harness name's: the daemon and a cloud sandbox
 * can both run `claude-sdk` and hold different credentials for it, so the entry
 * carries the same (server, scope, harness) triple the catalog does. A
 * `directory` of `null`/`undefined` names the central server's own runtime.
 */
export function providerAuthQuery(input: {
  baseUrl?: string
  client?: ProviderAuthClient
  directory?: string | null
  harnessType: string
  request?: (url: URL, init?: RequestInit) => Promise<Response>
}) {
  return {
    queryKey: queryKeys.controlPlane.providerAuth(
      input.baseUrl,
      input.directory ?? undefined,
      input.harnessType,
    ),
    staleTime: 0,
    queryFn: async () => {
      if (!input.baseUrl || !input.request) {
        if (!input.client) throw new Error("Provider auth requires a client or an authenticated request")
        return (await input.client.provider.auth()).data ?? {}
      }
      const url = new URL("/provider/auth", input.baseUrl)
      url.searchParams.set("harness", input.harnessType)
      if (input.directory) url.searchParams.set("directory", input.directory)
      const response = await input.request(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error((await response.text()) || `Failed to load ${input.harnessType} provider authentication`)
      return await response.json() as ProviderAuthResponse
    },
  }
}

export function providerDetailsQuery(input: {
  baseUrl: string
  providerId: string
  directory?: string | null
  harnessType: string
  request: (url: URL, init?: RequestInit) => Promise<Response>
}) {
  return {
    queryKey: queryKeys.controlPlane.providers(input.baseUrl, input.directory ?? undefined, input.harnessType),
    queryFn: async () => {
      const url = new URL("/provider", input.baseUrl)
      url.searchParams.set("provider", input.providerId)
      url.searchParams.set("harness", input.harnessType)
      if (input.directory) url.searchParams.set("directory", input.directory)
      const response = await input.request(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error((await response.text()) || `Failed to load ${input.providerId} models`)
      return normalizeProviderList(await response.json() as ProviderListResponse)
    },
  }
}
