import type { ClaxedoCommand as Command, ClaxedoProject as Project, ClaxedoProviderAuth as ProviderAuthResponse, ClaxedoProviderList as ProviderListResponse } from "@/platform/api/claxedo-api-types"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { cmp } from "@/platform/query/sort"
import { mergeProviderIndexWithDetails, normalizeProviderList } from "@/platform/query/provider-list"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"

export type { ClaxedoProviderList as ProviderListResponse } from "@/platform/api/claxedo-api-types"

type ProjectClient = {
  project: {
    list: () => Promise<{ data?: Project[] }>
  }
}

type CommandClient = {
  command: {
    list: () => Promise<{ data?: Command[] }>
  }
}

export function createHttpShellBackend(input: {
  client: Partial<ProjectClient & CommandClient>
}) {
  return {
    listProjects: async () => {
      if (!input.client.project) throw new Error("shell backend requires project client")
      return (await input.client.project.list()).data
    },
    listCommands: async (_input: { directory: string }) => {
      if (!input.client.command) throw new Error("shell backend requires command client")
      return (await input.client.command.list()).data
    },
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
  directory?: string | null
  harnessType: string
  request?: typeof fetch
}) {
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
      const url = new URL("/api/claxedo/agent-config/providers", input.baseUrl ?? getClaxedoServerUrl())
      url.searchParams.set("nativeHarness", input.harnessType)
      const response = await (input.request ?? authFetch)(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error((await response.text()) || `Failed to load ${input.harnessType} models`)
      return normalizeProviderList(await response.json() as ProviderListResponse)
    },
  }
}

/**
 * Native provider credentials are owned by the control plane. Workspace scope
 * partitions presentation caches, but never routes credential reads to a VM.
 */
export function providerAuthQuery(input: {
  baseUrl?: string
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
      const url = new URL("/api/claxedo/agent-config/providers/auth", input.baseUrl ?? getClaxedoServerUrl())
      url.searchParams.set("nativeHarness", input.harnessType)
      const response = await (input.request ?? authFetch)(url, { headers: { Accept: "application/json" } })
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
      const url = new URL("/api/claxedo/agent-config/providers", input.baseUrl)
      url.searchParams.set("provider", input.providerId)
      url.searchParams.set("nativeHarness", input.harnessType)
      const response = await input.request(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error((await response.text()) || `Failed to load ${input.providerId} models`)
      return normalizeProviderList(await response.json() as ProviderListResponse)
    },
  }
}
