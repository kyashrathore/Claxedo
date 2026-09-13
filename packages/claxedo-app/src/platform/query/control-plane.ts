import type { AgentCommand as Command } from "@claxedo/agent-runtime-contract"
import type { ClaxedoProject as Project } from "@/platform/api/claxedo-api-types"
import type { ClaxedoProviderAuth as ProviderAuthResponse, ClaxedoProviderAuthMethod, ClaxedoProviderList as ProviderListResponse } from "@/platform/api/claxedo-api-types"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { cmp } from "@/platform/query/sort"
import { isProviderListResponse, mergeProviderIndexWithDetails, normalizeProviderList } from "@/platform/query/provider-list"
import { asRecord } from "@/lib/record"
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
    structuralSharing: (
      previous: Parameters<typeof mergeProviderIndexWithDetails>[0],
      index: Parameters<typeof mergeProviderIndexWithDetails>[1],
    ) => mergeProviderIndexWithDetails(previous, index),
    queryFn: async () => {
      const url = new URL("/api/claxedo/agent-config/providers", input.baseUrl ?? getClaxedoServerUrl())
      url.searchParams.set("nativeHarness", input.harnessType)
      const response = await (input.request ?? authFetch)(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error((await response.text()) || `Failed to load ${input.harnessType} models`)
      return normalizeProviderList(providerCatalogBody(await response.json(), input.harnessType))
    },
  }
}

/**
 * A provider catalog body, or a throw naming the harness whose catalog was
 * wrong. Throwing rather than normalising an unrecognisable body keeps the
 * query in an error state its own `retry` can act on, instead of caching an
 * empty catalog that looks like "this harness has no models".
 */
function providerCatalogBody(body: unknown, harnessType: string): ProviderListResponse {
  if (!isProviderListResponse(body)) throw new Error(`Received an unreadable ${harnessType} provider catalog`)
  return body
}

type AuthPrompt = NonNullable<ClaxedoProviderAuthMethod["prompts"]>[number]

const AUTH_METHOD_TYPES = ["oauth", "api", "token"] as const
const AUTH_PROMPT_TYPES = ["text", "select"] as const

function isAuthPrompt(value: unknown): value is AuthPrompt {
  const prompt = asRecord(value)
  if (!prompt || !AUTH_PROMPT_TYPES.some((kind) => kind === prompt.type)) return false
  return typeof prompt.key === "string" && typeof prompt.message === "string"
}

function isAuthMethod(value: unknown): value is ClaxedoProviderAuthMethod {
  const method = asRecord(value)
  if (!method || !AUTH_METHOD_TYPES.some((kind) => kind === method.type)) return false
  if (method.label !== undefined && typeof method.label !== "string") return false
  return method.prompts === undefined || (Array.isArray(method.prompts) && method.prompts.every(isAuthPrompt))
}

/**
 * Whether a body from `/agent-config/providers/auth` is the provider-auth map.
 *
 * Checks everything the connect form binds to — a method's kind and label, and
 * each prompt's kind, key and message — and passes the body through rather than
 * rebuilding it, so a field this app does not read today still reaches a build
 * that does. A body that fails this cannot drive the form at all, so the query
 * errors instead of rendering controls bound to nothing.
 */
export function isProviderAuthResponse(value: unknown): value is ProviderAuthResponse {
  const auth = asRecord(value)
  if (!auth) return false
  return Object.values(auth).every((methods) => Array.isArray(methods) && methods.every(isAuthMethod))
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
      const body: unknown = await response.json()
      if (!isProviderAuthResponse(body)) {
        throw new Error(`Received unreadable ${input.harnessType} provider authentication`)
      }
      return body
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
      return normalizeProviderList(providerCatalogBody(await response.json(), input.harnessType))
    },
  }
}
