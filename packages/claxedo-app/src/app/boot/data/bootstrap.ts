import {
  type Path,
  type Project,
  type ProviderListResponse,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { retry } from "@/lib/retry"
import { getFilename } from "@/lib/path"
import { showToast } from "@opencode-ai/ui/toast"
import { formatServerError } from "@/lib/server-errors"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { setProviderQueryData } from "@/platform/query/provider-cache"
import { projectCatalogMissingWorkspace } from "@/platform/query/control-plane"
import { commandListQuery } from "../../../features/session/data/query/shell"
import { agentListQuery, configQuery, pathQuery, projectCurrentQuery } from "../../../features/session/data/query/directory"
import { workspaceVcsQuery, type WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-query"
import { fastSessionSwitchAnyNetworkQuiet } from "@/platform/runtime/session-switch"
import { cachedWorkspaceRuntimeRecord, workspaceRuntimeRoutingRecord } from "@/platform/runtime/workspace-runtime-record"
import { workspaceRuntimeBlocksBootstrap } from "@/platform/runtime/workspace-runtime-record"
import { normalizeProviderList } from "@/platform/query/provider-list"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { createTransport } from "@/platform/runtime/transport"
import { harnessQueryFetch } from "@/platform/runtime/harness-query-fetch"
import type { DirectorySessionCacheRefreshOptions } from "@/features/session/data/sync/directory-session-cache"
import { getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"
import {
  activateServicesForLocalCentral,
  synchronizeServiceCatalogFromBootstrap,
} from "@/app/composition/service-contributions"

type OpencodeClient = ReturnType<typeof createOpencodeClient>
export type GlobalBootstrapSdk = Pick<OpencodeClient, "global" | "path" | "project" | "provider">
export type DirectoryBootstrapSdk = Pick<OpencodeClient, "project" | "provider" | "app" | "config" | "path" | "command" | "vcs">
type BootstrapDirectory = string

export type GlobalBootstrapState = {
  ready: boolean
  path: Path
  reload: undefined | "pending" | "complete"
}

type Boot = {
  healthy?: boolean
  authenticated?: boolean
  services?: unknown
  version?: string
  path?: Path
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object"
}

function record(input: unknown) {
  return isRecord(input) ? input : undefined
}

function isProviderListResponse(input: unknown): input is ProviderListResponse {
  const row = record(input)
  if (!row) return false
  return Array.isArray(row.all) && Array.isArray(row.connected) && !!record(row.default)
}

function isBoot(input: unknown): input is Boot {
  return !!record(input)
}

async function providerListResponse(res: Response) {
  const data: unknown = await res.json().catch(() => undefined)
  if (!isProviderListResponse(data)) throw new Error("provider fetch returned invalid response")
  return data
}

function requireProviderListForRunner(input: ProviderListResponse, harnessType: string) {
  if (harnessType !== "opencode") return input
  if (input.all.some((provider) => provider.id === "opencode" && Object.keys(provider.models ?? {}).length > 0)) return input
  throw new Error("OpenCode provider fetch returned a catalog without OpenCode models")
}

function normalizedServerUrl(serverUrl: string | undefined) {
  return normalizeUrl(serverUrl) ?? getClaxedoServerUrl()
}

function isLoopbackServer(serverUrl: string | undefined) {
  return centralTransportForServer(serverUrl) === "loopback"
}

function providerBaseUrl(input: { serverUrl?: string; harnessType?: string }) {
  if (!input.harnessType || input.harnessType === "opencode") return input.serverUrl
  return input.serverUrl ?? getClaxedoServerUrl()
}

function claxedoBootstrapUrl(input: { serverUrl?: string; harnessType?: string }) {
  const url = new URL("/api/claxedo/bootstrap", normalizedServerUrl(input.serverUrl))
  if (input.harnessType) url.searchParams.set("harness", input.harnessType)
  return url
}

function opencodeProviderUrl(input: { serverUrl?: string; harnessType?: string; directory?: string }) {
  const url = new URL("/provider", normalizedServerUrl(providerBaseUrl(input)))
  if (input.harnessType) url.searchParams.set("harness", input.harnessType)
  if (input.directory) url.searchParams.set("directory", input.directory)
  return url
}

async function bootstrapData(baseUrl: string, fetchFn: typeof globalThis.fetch, harnessType?: string): Promise<Boot | undefined> {
  try {
    const res = await fetchFn(claxedoBootstrapUrl({ serverUrl: baseUrl, harnessType }), {
      headers: { Accept: "application/json" },
      // Cookies exist only on the hosted cookie product. The loopback daemon
      // authenticates locally, and its CORS deliberately never grants
      // credentialed cross-origin access — an `include` fetch from the dev
      // renderer origin (http://localhost:517x) is rejected outright there.
      credentials: isLoopbackServer(baseUrl) ? "omit" : "include",
    })
    if (!res.ok) return undefined
    const data: unknown = await res.json().catch(() => undefined)
    return isBoot(data) ? data : undefined
  } catch {
    return undefined
  }
}

function agentClient(input: {
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  directory: BootstrapDirectory
  harnessType?: string
}) {
  if (!input.baseUrl || !input.harnessType) return undefined
  return createOpencodeClient({
    baseUrl: input.baseUrl,
    fetch: harnessQueryFetch({
      request: input.fetch,
      harnessType: input.harnessType,
      baseUrl: normalizedServerUrl(getClaxedoServerUrl()),
    }),
    directory: input.directory,
  })
}

function postPaint(task: () => void) {
  setTimeout(task, 0)
}

/**
 * Runs `task` off the render-blocking path: on the browser's idle callback
 * where available, otherwise a macrotask tick. This module's own directory
 * warmup (provider/vcs prefetch, below) uses it for exactly the same reason
 * any other post-boot write should: the result was already applied locally,
 * so the network call is bookkeeping, not something the first paint needs.
 * Exported so other boot-adjacent callers (e.g. `layout.tsx`'s cold-boot
 * project-color persistence) share the one scheduling policy instead of
 * each re-implementing `requestIdleCallback` with its own fallback.
 */
export function runIdleWarmup(task: () => Promise<void>) {
  const run = () => {
    void task().catch(() => {})
  }
  if (globalThis.requestIdleCallback) {
    globalThis.requestIdleCallback(run)
    return
  }
  setTimeout(run, 0)
}

function isRemoteWorkspace(
  workspace: WorkspaceRuntimeSnapshot | null | undefined,
): workspace is WorkspaceRuntimeSnapshot & { workspaceId: string; kind: "cloud" | "user-hosted" } {
  return !!workspace?.workspaceId && (workspace.kind === "cloud" || workspace.kind === "user-hosted")
}

function workspaceDirectoryRef(directory: BootstrapDirectory) {
  return !!sessionWorkspaceRuntimeRef({ directory })
}

function pathFromWorkspace(directory: BootstrapDirectory, workspace: WorkspaceRuntimeSnapshot): Path {
  const resolved = workspace.directory ?? directory
  return { state: "", config: "", worktree: resolved, directory: resolved, home: "" }
}

function setDirectoryPathQuery(baseUrl: string | undefined, directory: BootstrapDirectory, path: Path) {
  queryClient.setQueryData(queryKeys.directory.path(baseUrl, directory), path)
}

function setDirectoryProjectQuery(baseUrl: string | undefined, directory: BootstrapDirectory, project: string) {
  queryClient.setQueryData(queryKeys.directory.project(baseUrl, directory), project)
}

const EMPTY_PATH: Path = { state: "", config: "", worktree: "", directory: "", home: "" }

function serviceCatalogUrl(serverUrl: string | undefined) {
  return new URL("/api/claxedo/services", normalizedServerUrl(serverUrl))
}

/**
 * The first-party service catalog for a hosted central.
 *
 * Only a hosted central issues one, and it has no aggregate to ride on, so the
 * catalog is its own small read. The payload is the `{ authenticated, services }`
 * pair `synchronizeServiceCatalogFromBootstrap` consumes —
 * `authenticated: false` is authoritative sign-out and must deactivate
 * already-loaded services. A loopback daemon mounts no such route and its
 * aggregate carries no `services`; see `activateServicesForLocalCentral`.
 */
async function fetchServiceCatalog(baseUrl: string, fetchFn: typeof globalThis.fetch) {
  const res = await fetchFn(serviceCatalogUrl(baseUrl), {
    headers: { Accept: "application/json" },
    credentials: "include",
  })
  if (!res.ok) throw new Error(`service catalog fetch failed: ${res.status}`)
  return await res.json() as unknown
}

export async function bootstrapGlobal(input: {
  baseUrl: string
  globalSDK: GlobalBootstrapSdk
  fetch: typeof globalThis.fetch
  connectErrorTitle: string
  connectErrorDescription: string
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalState: (patch: Partial<GlobalBootstrapState>) => void
  harnessType?: string
}) {
  // Off loopback there is no aggregate to read: the browser has already
  // resolved the auth descriptor and its session, the workspace catalog is its
  // own query (`features/workspaces/data/workspace-catalog.ts`), and every
  // other former bootstrap field is per-workspace, per-harness, or a stub.
  if (!isLoopbackServer(input.baseUrl)) {
    try {
      await synchronizeServiceCatalogFromBootstrap(await fetchServiceCatalog(input.baseUrl, input.fetch))
    } catch (error) {
      showToast({
        variant: "error",
        title: input.requestFailedTitle,
        description: formatServerError(error, input.translate),
      })
    }
    input.setGlobalState({ ready: true })
    return
  }

  // A loopback central issues no catalog, in the aggregate or anywhere else, so
  // the build's loaders are the authority for what it may render — the same
  // answer `documentsAccess` already gives for this transport. Resolved before
  // the aggregate and independently of it: service availability is a property
  // of the central, not of whether the daemon answered a boot payload.
  try {
    await activateServicesForLocalCentral()
  } catch (error) {
    showToast({
      variant: "error",
      title: input.requestFailedTitle,
      description: formatServerError(error, input.translate),
    })
  }

  const boot = await bootstrapData(input.baseUrl, input.fetch, input.harnessType)
  if (boot?.healthy) {
    const path = boot.path ?? EMPTY_PATH
    input.setGlobalState({ path })
    queryClient.setQueryData(queryKeys.directory.path(input.baseUrl, ""), path)
    input.setGlobalState({ ready: true })
    return
  }

  const health = await input.globalSDK.global
    .health()
    .then((x) => x.data)
    .catch(() => undefined)
  if (!health?.healthy) {
    showToast({
      variant: "error",
      title: input.connectErrorTitle,
      description: input.connectErrorDescription,
    })
    input.setGlobalState({ ready: true })
    return
  }

  await retry(() =>
    input.globalSDK.path.get().then((x) => {
      input.setGlobalState({ path: x.data! })
      queryClient.setQueryData(queryKeys.directory.path(input.baseUrl, ""), x.data!)
    }),
  ).catch((error: unknown) => {
    showToast({
      variant: "error",
      title: input.requestFailedTitle,
      description: formatServerError(error, input.translate),
    })
  })
  input.setGlobalState({ ready: true })
}

export async function bootstrapDirectory(input: {
  directory: BootstrapDirectory
  sdk: DirectoryBootstrapSdk
  loadSessions: (directory: BootstrapDirectory, opts?: DirectorySessionCacheRefreshOptions) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  harnessType?: string
  quiet?: boolean
  workspace?: WorkspaceRuntimeSnapshot & { workspaceId: string; kind: "cloud" | "user-hosted" }
}) {
  const harnessType = input.harnessType ?? (workspaceDirectoryRef(input.directory) ? "opencode" : undefined)
  // The model catalog must be fetched with an explicit harness. The provider
  // route cannot identify the OpenCode runner unless the
  // request carries `?harness=`. `harnessType` is intentionally left undefined for
  // opencode sessions so the agents/session caches use the default no-harness path,
  // but that starves the provider fetch — so reopening an opencode session showed
  // "Select model" until a session was created. opencode is the default harness, so
  // resolve a dedicated runner for the provider fetch only.
  const providerHarnessType = harnessType ?? "opencode"

  const runtimeRequest = (workspace: WorkspaceRuntimeSnapshot | null | undefined) => {
    if (!input.baseUrl) return undefined
    if (isRemoteWorkspace(workspace)) {
      return createTransport({
        placement: {
          workspaceId: workspace.workspaceId,
          hosting: "workspace",
          transport: isLoopbackServer(input.baseUrl) ? "loopback" : "workspace-relay",
        },
        serverUrl: input.baseUrl,
        directory: input.directory,
        request: input.fetch,
      })
    }
    // Signed workspace refs (`workspace:<id>` / `ws_<id>` directories) carry a
    // relay connection even when the central cannot resolve the directory —
    // hosted centrals have no workspace resolve route and no central harness.
    // Route runtime-owned reads (the provider catalog) through the relay to the
    // workspace runtime instead of the central global route. Only when the
    // resolve produced nothing (a resolved `local` workspace stays central) and
    // the server is not the loopback local server (which owns the provider route).
    if (workspace) return undefined
    if (isLoopbackServer(input.baseUrl)) return undefined
    const ref = sessionWorkspaceRuntimeRef({ directory: input.directory })
    if (!ref) return undefined
    return createTransport({
      placement: { workspaceId: ref.workspaceId, hosting: "workspace", transport: "workspace-relay" },
      serverUrl: input.baseUrl,
      directory: input.directory,
      request: input.fetch,
    })
  }

  const providerFetchError = async (response: Response) => {
    const text = await response.text().catch(() => "")
    if (!text.trim()) return `provider fetch failed: ${response.status}`
    try {
      const body = record(JSON.parse(text))
      const error = record(body?.error)
      const message = typeof error?.message === "string"
        ? error.message
        : typeof body?.message === "string"
          ? body.message
          : ""
      if (message) return `${message} (${response.status})`
    } catch {}
    return `${text.trim()} (${response.status})`
  }

  const fetchProvider = (workspace?: WorkspaceRuntimeSnapshot | null) => {
    const runtimeRef = sessionWorkspaceRuntimeRef({ directory: input.directory })
    const scope = isRemoteWorkspace(workspace)
      ? `workspace:${workspace.workspaceId}`
      : runtimeRef
        ? `workspace:${runtimeRef.workspaceId}`
        : input.directory
    const providerQueryKey = queryKeys.controlPlane.providers(input.baseUrl, scope, providerHarnessType)
    const setProviderQuery = (data: NormalizedProviderListResponse) => {
      const empty = !data.all || data.all.size === 0
      if (empty) {
        const existing = queryClient.getQueryData<NormalizedProviderListResponse>(providerQueryKey)
        if (existing?.all && existing.all.size > 0) return
      }
      setProviderQueryData(providerQueryKey, data)
    }
    const baseUrl = input.baseUrl
    const runtime = runtimeRequest(workspace)
    if (runtime && baseUrl) {
      const url = opencodeProviderUrl({
        serverUrl: baseUrl,
        harnessType: providerHarnessType,
        directory: scope,
      })
      return runtime.fetch(`${url.pathname}${url.search}`).then(async (r) => {
        if (!r.ok) throw new Error(await providerFetchError(r))
        return requireProviderListForRunner(await providerListResponse(r), providerHarnessType)
      }).then((data) => {
        setProviderQuery(normalizeProviderList(data))
      })
    }
    if (providerHarnessType && input.baseUrl) {
      return (input.fetch ?? globalThis.fetch)(opencodeProviderUrl({
        serverUrl: input.baseUrl,
        harnessType: providerHarnessType,
        directory: scope,
      })).then(async (r) => {
        if (!r.ok) throw new Error(await providerFetchError(r))
        return requireProviderListForRunner(await providerListResponse(r), providerHarnessType)
      }).then((data) => {
        setProviderQuery(normalizeProviderList(data))
      })
    }
    return input.sdk.provider.list().then((x) => {
      setProviderQuery(normalizeProviderList(x.data!))
    })
  }

  // The provider fetch now runs only behind the WorkspaceGate's `ready` branch
  // (DirectoryScope mounts inside it) and through queries gated by the
  // WorkspaceConnection authority — so it cannot fire while the workspace is
  // offline. The connection-failure surface is owned ONCE by the authority/gate
  // (access-denied / offline view), so the old per-call "Failed to load models"
  // toast + 403-suppression dance is deleted (BUG-9). Failures here propagate
  // silently to callers (all `.catch(() => undefined)`), with no toast spam.
  //
  // Fetch-once within this bootstrap: the pre-paint fetch below and the idle
  // warmup both ask for the same catalog (`fetchProvider` is a raw fetch, not
  // a cached query), which measured as two identical `GET /provider?harness=…`
  // requests per boot on the launch-project perf lane. A successful fetch
  // satisfies both; the warmup only refetches when the first attempt failed
  // (e.g. the runtime was still coming up pre-paint).
  let providerFetched = false
  const fetchProviderOrNotify = (workspace?: WorkspaceRuntimeSnapshot | null) => {
    if (providerFetched) return Promise.resolve()
    return fetchProvider(workspace).then(() => {
      providerFetched = true
    })
  }

  // Everything below reads this record as ROUTING IDENTITY — which workspace
  // backs the directory, so the provider catalog, config and VCS warm address
  // the right runtime. None of them read `status`, so this must not be taken
  // on the liveness path: that put a control-plane resolve on whatever the
  // user was doing whenever the freshness window happened to elapse.
  const resolveWorkspace = () => {
    if (input.workspace) return Promise.resolve(input.workspace)
    if (!workspaceDirectoryRef(input.directory)) return Promise.resolve(undefined)
    const scope = { baseUrl: input.baseUrl, request: input.fetch, directory: input.directory }
    // Warm-up has no claim on the user's click: inside a session activation's
    // network-quiet window this answers from cache or not at all.
    if (fastSessionSwitchAnyNetworkQuiet()) {
      return Promise.resolve(cachedWorkspaceRuntimeRecord(scope) ?? undefined)
    }
    return workspaceRuntimeRoutingRecord(scope).catch(() => undefined)
  }

  const warmRuntimeVcs = (workspace: WorkspaceRuntimeSnapshot | null | undefined) =>
    queryClient.fetchQuery(workspaceVcsQuery({
      baseUrl: input.baseUrl,
      directory: input.directory,
      request: input.fetch,
      workspaceId: isRemoteWorkspace(workspace) ? workspace.workspaceId : undefined,
      workspace,
      signedControlPlane: isRemoteWorkspace(workspace),
      client: input.sdk,
    })).catch(() => undefined)

  try {
    await input.loadSessions(input.directory, {
      quiet: input.quiet,
      workspace: input.workspace,
    })
  } catch (error) {
    if (!input.quiet) {
      const project = getFilename(input.directory)
      const message = formatServerError(error, input.translate)
      showToast({ variant: "error", title: `Failed to reload ${project}`, description: message })
    }
  }

  if (providerHarnessType) {
    await fetchProviderOrNotify(await resolveWorkspace()).catch(() => undefined)
  }

  postPaint(() => {
    const workspace = resolveWorkspace()

    void workspace.then((ws) => {
      if (isRemoteWorkspace(ws)) {
        if (ws.projectId) setDirectoryProjectQuery(input.baseUrl, input.directory, ws.projectId)
        setDirectoryPathQuery(input.baseUrl, input.directory, pathFromWorkspace(input.directory, ws))
        return
      }
      void Promise.allSettled([
        retry(() =>
          queryClient.fetchQuery(projectCurrentQuery({
            baseUrl: input.baseUrl,
            directory: input.directory,
            client: input.sdk,
          })),
        ).then(async () => {
          // `projectCurrentQuery` is the request that registers this workspace
          // in the claxedo store, so until it resolves the catalog seeded by
          // global bootstrap can legitimately be missing it (see
          // `projectCatalogMissingWorkspace`). The catalog is cached with a
          // five-minute `staleTime` and nothing else refetches it, which used
          // to leave the rail on the engine-shaped payload — worktree basename
          // for a name, and no sessions — until the user opened a surface.
          // Refetch only when the catalog really is missing this workspace, so
          // the common warm boot stays a no-op.
          const queryKey = queryKeys.controlPlane.projects(input.baseUrl)
          const cached = queryClient.getQueryData<Array<Project & { workspaces?: Record<string, unknown> }>>(queryKey)
          if (!projectCatalogMissingWorkspace(cached, input.directory)) return
          await queryClient.invalidateQueries({ queryKey })
        }),
        retry(() =>
          queryClient.fetchQuery(configQuery({
            baseUrl: input.baseUrl,
            directory: input.directory,
            workspace: ws,
            client: input.sdk,
          })),
        ),
        workspace,
      ])
    })

    void workspace.then((ws) => {
      runIdleWarmup(async () => {
        if (workspaceRuntimeBlocksBootstrap(ws)) {
          if (ws) setDirectoryPathQuery(input.baseUrl, input.directory, pathFromWorkspace(input.directory, ws))
          await Promise.allSettled([
            warmRuntimeVcs(ws),
            fetchProviderOrNotify(ws),
            isRemoteWorkspace(ws)
              ? Promise.resolve()
              : queryClient.fetchQuery(pathQuery({
                  baseUrl: input.baseUrl,
                  directory: input.directory,
                  client: input.sdk,
                })),
          ])
          return
        }

        await Promise.allSettled([
          warmRuntimeVcs(ws),
          fetchProviderOrNotify(ws),
          retry(() =>
            queryClient.fetchQuery(agentListQuery({
              baseUrl: input.baseUrl,
              directory: input.directory,
              harnessType,
              request: input.fetch,
              workspace: ws,
              client: agentClient({
                baseUrl: input.baseUrl,
                fetch: input.fetch,
                directory: input.directory,
                harnessType,
              }) ?? input.sdk,
            })),
          ),
          isRemoteWorkspace(ws)
            ? Promise.resolve()
            : queryClient.fetchQuery(pathQuery({
                baseUrl: input.baseUrl,
                directory: input.directory,
                client: input.sdk,
              })),
          queryClient.fetchQuery(commandListQuery({
            baseUrl: input.baseUrl,
            directory: input.directory,
            request: input.fetch,
            workspace: ws,
            client: input.sdk,
          })),
        ])
      })
    })
  })
}
