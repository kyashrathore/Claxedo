import type { AgentCommand } from "@claxedo/agent-runtime-contract"
import type { WorkspaceVcsInfo } from "@claxedo/workspace-runtime/client"
import type { ClaxedoPath as Path, ClaxedoProject as Project } from "@/platform/api/claxedo-api-types"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { asRecord, readBoolean, readNullableString, readString } from "@/lib/record"
import { retry } from "@/lib/retry"
import { getFilename } from "@opencode-ai/ui/utils/path"
import { showToast } from "@opencode-ai/ui/toast"
import { formatServerError } from "@/lib/server-errors"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { setProviderQueryData } from "@/platform/query/provider-cache"
import { providerListQuery, projectCatalogMissingWorkspace, setHostAggregateDeclaration, setSelfHostDeclaration } from "@/platform/query/control-plane"
import { commandListQuery } from "../../../features/session/data/query/shell"
import { agentListQuery, pathQuery, projectCurrentQuery } from "../../../features/session/data/query/directory"
import { workspaceVcsQuery, type WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-query"
import { fastSessionSwitchAnyNetworkQuiet } from "@/platform/runtime/session-switch"
import { cachedWorkspaceRuntimeRecord, workspaceRuntimeRoutingRecord } from "@/platform/runtime/workspace-runtime-record"
import { workspaceRuntimeBlocksBootstrap } from "@/platform/runtime/workspace-runtime-record"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import type { DirectorySessionCacheRefreshOptions } from "@/features/session/data/sync/directory-session-cache"
import { getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"
import {
  activateServicesForLocalCentral,
  synchronizeServiceCatalogFromBootstrap,
} from "@/app/composition/service-contributions"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"

type DataResponse<T> = Promise<{ data?: T }>

export type GlobalBootstrapSdk = {
  global: {
    health(): DataResponse<{ healthy: boolean; version?: string }>
  }
  path: { get(): DataResponse<Path> }
  project: { list(): DataResponse<Project[]> }
}

export type DirectoryBootstrapSdk = {
  project: { current(): DataResponse<Project> }
  path: { get(): DataResponse<Path> }
  command: { list(): DataResponse<AgentCommand[]> }
  vcs: { get(): DataResponse<WorkspaceVcsInfo> }
}
type BootstrapDirectory = string

export type GlobalBootstrapState = {
  ready: boolean
  path: Path
  reload: undefined | "pending" | "complete"
}

type Boot = {
  healthy?: boolean
  path?: Path
  /**
   * The server's own answer to "do you serve the host aggregate `wr/events`?".
   * Absent from a server old enough not to declare it, which reads as "not
   * declared" rather than as `false` — see `hostAggregateDeclaration`.
   */
  hostAggregate?: boolean
  /**
   * This machine's enrollment id, as the server it is talking to declares it.
   * `null` is an explicit "this server is not enrolled"; absent is a server
   * that does not declare the field at all, and both mean the same to the
   * resolver: nothing here recognises itself in a control-plane row.
   */
  hostEnrollment?: string | null
}

/**
 * Read the bootstrap response into the fields this module uses.
 *
 * The body arrives as `unknown` and asserting it into `Boot` certifies nothing:
 * `path` is handed to `setGlobalState` and cached under `queryKeys.directory.path`
 * as five guaranteed strings, and every consumer reads `path.worktree` without
 * checking. Each field is read for its own type instead, and a `path` missing
 * any member is dropped so the caller's `EMPTY_PATH` fallback runs.
 */
function toBoot(input: unknown): Boot | undefined {
  const data = asRecord(input)
  if (!data) return undefined
  return {
    healthy: readBoolean(data, "healthy"),
    path: toPath(data.path),
    hostAggregate: readBoolean(data.events, "hostAggregate"),
    hostEnrollment: readNullableString(data.host, "enrollment"),
  }
}

function toPath(input: unknown): Path | undefined {
  const home = readString(input, "home")
  const state = readString(input, "state")
  const config = readString(input, "config")
  const worktree = readString(input, "worktree")
  const directory = readString(input, "directory")
  // Presence, not truth: the global payload carries `worktree` and `directory`
  // as "" by contract (no project is scoped yet), and treating "" as missing
  // throws away `home` with it — the folder picker then has nowhere to start.
  if (home === undefined || state === undefined || config === undefined || worktree === undefined || directory === undefined) {
    return undefined
  }
  return { home, state, config, worktree, directory }
}

function normalizedServerUrl(serverUrl: string | undefined) {
  return normalizeUrl(serverUrl) ?? getClaxedoServerUrl()
}

export function isLoopbackServer(serverUrl: string | undefined) {
  return centralTransportForServer(serverUrl) === "loopback"
}

function claxedoBootstrapUrl(input: { serverUrl?: string; harnessType?: string }) {
  const url = new URL("/api/claxedo/bootstrap", normalizedServerUrl(input.serverUrl))
  if (input.harnessType) url.searchParams.set("harness", input.harnessType)
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
    return toBoot(data)
  } catch {
    return undefined
  }
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
): workspace is WorkspaceRuntimeSnapshot & { workspaceId: string; kind: RelayHostKind } {
  return !!workspace?.workspaceId && (workspace.kind === "provisioner" || workspace.kind === "machine")
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
    if (boot.hostAggregate !== undefined) setHostAggregateDeclaration(input.baseUrl, boot.hostAggregate)
    setSelfHostDeclaration(input.baseUrl, boot.hostEnrollment
      ? { kind: "enrolled", enrollmentId: boot.hostEnrollment }
      : { kind: "unenrolled" })
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
  fetch: typeof globalThis.fetch
  baseUrl: string
  harnessType?: string
  quiet?: boolean
  workspace?: WorkspaceRuntimeSnapshot & { workspaceId: string; kind: RelayHostKind }
}) {
  const harnessType = input.harnessType
  const providerHarnessType = harnessType

  const fetchProvider = (workspace?: WorkspaceRuntimeSnapshot | null) => {
    const runtimeRef = sessionWorkspaceRuntimeRef({ directory: input.directory })
    const scope = isRemoteWorkspace(workspace)
      ? `workspace:${workspace.workspaceId}`
      : runtimeRef
        ? `workspace:${runtimeRef.workspaceId}`
        : input.directory
    const providerQueryKey = queryKeys.controlPlane.providers(input.baseUrl, scope, providerHarnessType ?? "")
    const setProviderQuery = (data: NormalizedProviderListResponse) => {
      const empty = !data.all || data.all.size === 0
      if (empty) {
        const existing = queryClient.getQueryData<NormalizedProviderListResponse>(providerQueryKey)
        if (existing?.all && existing.all.size > 0) return
      }
      setProviderQueryData(providerQueryKey, data)
    }
    return providerListQuery({
      baseUrl: input.baseUrl,
      directory: scope,
      harnessType: providerHarnessType!,
      request: input.fetch,
    }).queryFn().then(setProviderQuery)
  }

  // Pre-paint and idle warmup share one successful catalog read.
  let providerFetched = false
  const fetchProviderOrNotify = (workspace?: WorkspaceRuntimeSnapshot | null) => {
    if (!providerHarnessType || providerFetched) return Promise.resolve()
    return fetchProvider(workspace).then(() => {
      providerFetched = true
    })
  }

  // Background catalog and VCS reads need workspace routing identity, not a
  // liveness probe. Keep their resolution separate from interactive health checks.
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
          // the common warm boot stays a no-op. `refetchType: "all"` because
          // the catalog query need not have an observer at this moment (a
          // worktree created at first send bootstraps before any pane mounts
          // on it) and an inactive query would otherwise only be marked stale,
          // leaving the create-session handoff without a route for it.
          const queryKey = queryKeys.controlPlane.projects(input.baseUrl)
          const cached = queryClient.getQueryData<Array<Project & { workspaces?: Record<string, unknown> }>>(queryKey)
          if (!projectCatalogMissingWorkspace(cached, input.directory)) return
          await queryClient.invalidateQueries({ queryKey, refetchType: "all" })
        }),
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
