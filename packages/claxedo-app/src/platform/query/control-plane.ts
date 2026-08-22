import type { Command, Project, ProviderAuthResponse, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
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
 * the query (previously: opening a surface, via `ensureProject`).
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

/**
 * The harness a provider cache entry BELONGS TO, which is not always the
 * harness the REQUEST must name.
 *
 * `/provider` resolves an absent `?harness=` to the configured default harness
 * (`resolveHarnessId` -> `defaultHarness`, which falls back to `opencode`), so
 * an unqualified request and an `opencode`-qualified one return the SAME
 * catalog. `useProviders()` asks unqualified; the directory bootstrap asks with
 * an explicit `?harness=opencode` because the route cannot otherwise identify
 * the OpenCode harness. Keying on the wire qualifier made those two different
 * cache entries.
 */
export function providerCacheHarness(harnessType: string | undefined) {
  return !harnessType || harnessType === "opencode" ? undefined : harnessType
}

export function providerListQuery(input: {
  baseUrl?: string
  client: ProviderClient
  directory?: string | null
  harnessType?: string
  request?: typeof fetch
}) {
  const backend = createHttpShellBackend({
    client: input.client,
  })
  return {
    queryKey: queryKeys.controlPlane.providers(
      input.baseUrl,
      input.directory ?? undefined,
      providerCacheHarness(input.harnessType),
    ),
    staleTime: 5 * 60 * 1000,
    structuralSharing: (previous: unknown, index: unknown) => mergeProviderIndexWithDetails(
      previous as Parameters<typeof mergeProviderIndexWithDetails>[0],
      index as Parameters<typeof mergeProviderIndexWithDetails>[1],
    ),
    queryFn: async () => {
      if (!input.harnessType) {
        return normalizeProviderList((await backend.listProviders()) ?? { all: [], connected: [], default: {} })
      }
      if (!input.baseUrl || !input.request) throw new Error("Harness provider query requires an authenticated request")
      const url = new URL("/provider", input.baseUrl)
      url.searchParams.set("harness", input.harnessType)
      if (input.directory) url.searchParams.set("directory", input.directory)
      const response = await input.request(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error((await response.text()) || `Failed to load ${input.harnessType} models`)
      return normalizeProviderList(await response.json() as ProviderListResponse)
    },
  }
}

export function providerAuthQuery(input: {
  baseUrl?: string
  client: ProviderAuthClient
  harnessType?: string
  request?: typeof fetch
}) {
  return {
    queryKey: queryKeys.controlPlane.providerAuth(input.baseUrl, input.harnessType),
    staleTime: 0,
    queryFn: async () => {
      if (!input.harnessType) return (await input.client.provider.auth()).data ?? {}
      if (!input.baseUrl || !input.request) throw new Error("Harness provider auth query requires an authenticated request")
      const url = new URL("/provider/auth", input.baseUrl)
      url.searchParams.set("harness", input.harnessType)
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
  harnessType?: string
  request: (url: URL, init?: RequestInit) => Promise<Response>
}) {
  return {
    queryKey: queryKeys.controlPlane.providers(input.baseUrl, input.directory ?? undefined, input.harnessType),
    queryFn: async () => {
      const url = new URL("/provider", input.baseUrl)
      url.searchParams.set("provider", input.providerId)
      if (input.harnessType) url.searchParams.set("harness", input.harnessType)
      if (input.directory) url.searchParams.set("directory", input.directory)
      const response = await input.request(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error((await response.text()) || `Failed to load ${input.providerId} models`)
      return normalizeProviderList(await response.json() as ProviderListResponse)
    },
  }
}
