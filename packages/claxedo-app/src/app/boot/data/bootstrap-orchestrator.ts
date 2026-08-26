import { queryOptions, skipToken } from "@tanstack/solid-query"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@/lib/path"
import { formatServerError } from "@/lib/server-errors"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"
import { authFetch } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import { agentListQuery, pathQuery } from "../../../features/session/data/query/directory"
import { projectListQuery, providerAuthQuery, providerListQuery } from "@/platform/query/control-plane"
import { mapInventoryToSessions } from "../../../features/session/data/query/inventory"
import { cleanupDroppedSessionCaches } from "../../../features/session/data/sync/session-cache-cleanup"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "@/platform/sync/session-load"
import { bootstrapDirectory, bootstrapGlobal, type GlobalBootstrapState } from "./bootstrap"
import type { SessionCacheValue, SessionInventoryRow, WorkspaceGroup } from "../../../features/session/data/sync/global-sync-types"
import { SESSION_RECENT_LIMIT } from "../../../features/session/data/sync/global-sync-types"
import type { SignedWorkspaceInfo } from "@/platform/runtime/agent/signed-workspace"
import type { WorkspaceSessionBacking } from "@/platform/identity/session-ref"
import {
  sessionLoadMetaKey,
  sessionLoadMetaMatchesWorkspace,
  type DirectorySessionCacheRefreshOptions,
  type DirectorySessionLoadMeta,
} from "../../../features/session/data/sync/directory-session-cache"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { trimSessions } from "../../../platform/sync/global-sync/session-trim"
import { shouldUseSignedControlPlaneInventory, type InventoryGlobalSession } from "../../../features/session/data/sync/inventory-source"

type DirectoryRef = string
type SessionRow = SessionCacheValue["session"][number]
type GlobalConfig = Config
type QueryOptionsClient =
  Parameters<typeof projectListQuery>[0]["client"] &
  Parameters<typeof providerListQuery>[0]["client"] &
  Parameters<typeof providerAuthQuery>[0]["client"] &
  Parameters<typeof pathQuery>[0]["client"] &
  Parameters<typeof agentListQuery>[0]["client"] & {
    global: { config: { get: () => Promise<{ data?: GlobalConfig }> } }
    mcp: { status: () => Promise<{ data?: unknown }> }
    lsp: { status: () => Promise<{ data?: unknown[] }> }
  }
type SessionListClient = {
  session: {
    list: (query: { directory: DirectoryRef; roots: true; limit?: number }) => Promise<{ data?: SessionRow[] }>
  }
}
type DirectoryChildren = {
  pin: (directory: DirectoryRef) => void
  unpin: (directory: DirectoryRef) => void
  sessionCache: (directory: DirectoryRef) => SessionCacheValue
}
type WorkspaceInfo = SignedWorkspaceInfo
type RuntimeRef = { workspaceId: string }
type Translate = (key: string, vars?: Record<string, string | number>) => string

export function bootstrapSessionRuntimeTarget(input: {
  workspace?: WorkspaceSessionBacking
  runtimeRef?: RuntimeRef
}) {
  if (input.workspace) {
    return {
      workspaceId: input.workspace.workspaceId,
      workspaceKind: input.workspace.kind,
      signedControlPlane: true,
    } as const
  }
  if (!input.runtimeRef) return
  return { workspaceId: input.runtimeRef.workspaceId } as const
}

export function sessionInventoryMatchesWorkspace(
  inventory: Pick<WorkspaceGroup, "workspaceId"> | undefined,
  workspace: WorkspaceSessionBacking | undefined,
) {
  return !workspace || inventory?.workspaceId === workspace.workspaceId
}

export function runtimeInventoryWorkspaceIdentity(input: {
  directory: DirectoryRef
  requestedWorkspace?: WorkspaceSessionBacking
  signedWorkspace?: WorkspaceInfo
}) {
  const workspaceId = input.requestedWorkspace?.workspaceId ?? input.signedWorkspace?.workspaceId ?? input.directory
  const metadata = input.signedWorkspace?.workspaceId === workspaceId ? input.signedWorkspace : undefined
  return {
    workspaceId,
    directory: metadata?.directory ?? input.directory,
    workspaceName: metadata?.workspaceName,
  }
}

export const loadMcpQuery = (directory: DirectoryRef, sdk?: QueryOptionsClient) =>
  queryOptions({
    queryKey: [directory, "mcp"],
    queryFn: sdk ? () => sdk.mcp.status().then((r) => r.data ?? {}) : skipToken,
  })

export const loadLspQuery = (directory: DirectoryRef, sdk?: QueryOptionsClient) =>
  queryOptions({
    queryKey: [directory, "lsp"],
    queryFn: sdk ? () => sdk.lsp.status().then((r) => r.data ?? []) : skipToken,
  })

export function workspaceScopedCacheKey(input: { directory: DirectoryRef; workspaceId?: string }) {
  return input.workspaceId ?? input.directory
}

export function bootstrapRequestKey(
  directory: DirectoryRef,
  harnessType?: string,
  workspace?: WorkspaceSessionBacking,
) {
  const authority = workspace
    ? `${workspace.kind}:${workspace.workspaceId}:${workspace.hostId ?? ""}`
    : "local"
  return ["shell", "global-sync", "bootstrap", directory, harnessType ?? "", authority, "request"] as const
}

export function bootstrapRequestPrefix(directory: DirectoryRef) {
  return ["shell", "global-sync", "bootstrap", directory] as const
}

export function globalBootstrapRequestKey(baseUrl: string, harnessType?: string) {
  return ["shell", "global-sync", "bootstrap", "global", baseUrl, harnessType ?? "", "request"] as const
}

export function globalBootstrapFreshKey(baseUrl: string, harnessType?: string) {
  return ["shell", "global-sync", "bootstrap", "global", baseUrl, harnessType ?? "", "fresh"] as const
}

export function sessionLoadRequestKey(directory: DirectoryRef) {
  return ["shell", "global-sync", "session-load", directory, "request"] as const
}

export function createQueryOptionsApi(input: {
  globalSDK: () => QueryOptionsClient
  sdkFor: (directory: DirectoryRef) => QueryOptionsClient
  baseUrl?: string
  request?: typeof fetch
  harnessType?: string
}) {
  return {
    globalConfig: () =>
      queryOptions({
        queryKey: ["global", input.baseUrl ?? "", "config"],
        staleTime: 5 * 60 * 1000,
        queryFn: async () => (await input.globalSDK().global.config.get()).data ?? ({} as GlobalConfig),
      }),
    projects: () => projectListQuery({ baseUrl: input.baseUrl, client: input.globalSDK() }),
    providers: (directory: DirectoryRef | null, harnessType?: string) =>
      providerListQuery({
        baseUrl: input.baseUrl,
        client: directory === null ? input.globalSDK() : input.sdkFor(directory),
        directory,
        harnessType,
        request: input.request,
      }),
    providerAuth: (harnessType?: string) => providerAuthQuery({
      baseUrl: input.baseUrl,
      client: input.globalSDK(),
      harnessType,
      request: input.request,
    }),
    path: (directory: DirectoryRef | null) =>
      pathQuery({
        baseUrl: input.baseUrl,
        directory: directory ?? "",
        client: directory === null ? input.globalSDK() : input.sdkFor(directory),
      }),
    agents: (directory: DirectoryRef) =>
      agentListQuery({
        baseUrl: input.baseUrl,
        directory,
        harnessType: input.harnessType,
        request: input.request,
        client: input.sdkFor(directory),
      }),
    mcp: (directory: DirectoryRef) => loadMcpQuery(directory, input.sdkFor(directory)),
    lsp: (directory: DirectoryRef) => loadLspQuery(directory, input.sdkFor(directory)),
    sessions: (directory: DirectoryRef) => ({ queryKey: [directory, "loadSessions"] as const }),
  }
}

export type QueryOptionsApi = ReturnType<typeof createQueryOptionsApi>

export function localLoopbackFetch(baseUrl: string) {
  if (!isLoopbackServer(baseUrl)) return
  return globalThis.fetch
}

export function globalBootstrapFetch(baseUrl: string, platformFetch?: typeof fetch) {
  return localLoopbackFetch(baseUrl) ?? platformFetch ?? authFetch
}

export function shouldUseSignedRouteBootstrap(input: {
  signedRoute: boolean
  baseUrl: string
  platformFetch?: typeof fetch
}) {
  if (!input.signedRoute) return false
  if (isLoopbackServer(input.baseUrl)) return false
  return !!input.platformFetch
}

function isLoopbackServer(baseUrl: string) {
  return centralTransportForServer(baseUrl) === "loopback"
}

function shouldUseLocalSessionListClient(input: { baseUrl: string; directory: DirectoryRef }) {
  return isLoopbackServer(input.baseUrl) && isFilesystemDirectory(input.directory)
}

function shouldSkipCentralSessionList(input: { baseUrl: string; directory: DirectoryRef }) {
  const loopback = isLoopbackServer(input.baseUrl)
  const filesystemDirectory = isFilesystemDirectory(input.directory)
  return loopback ? !filesystemDirectory : filesystemDirectory
}

export function createBootstrapOrchestrator(input: {
  baseUrl: () => string
  globalSDK: () => QueryOptionsClient & SessionListClient & Parameters<typeof bootstrapGlobal>[0]["globalSDK"]
  children: DirectoryChildren
  translate: Translate
  platformFetch: () => typeof fetch | undefined
  ready: () => boolean
  setGlobalState: (patch: Partial<GlobalBootstrapState>) => void
  initialRouteDirectory: () => DirectoryRef | undefined
  hasSignedAccess: () => boolean
  workspaceDirectoryRef: (directory: DirectoryRef) => boolean
  workspaceRuntimeRef: (directory: DirectoryRef) => RuntimeRef | undefined
  signedWorkspaceInfo: (directory: DirectoryRef) => WorkspaceInfo | undefined
  signedInventorySource: { fetchSignedDirectorySessions: (directory: DirectoryRef) => Promise<SessionInventoryRow[]> }
  sessionInventory: () => { byWorkspace: Record<string, WorkspaceGroup> }
  projectFor: (directory: DirectoryRef) => { id: string } | undefined
  inventoryRow: (session: InventoryGlobalSession) => SessionInventoryRow
  cacheSessions: (directory: DirectoryRef, value: Omit<SessionCacheValue, "at">) => void
  sessionCacheLimit: (directory: DirectoryRef, fallback: number) => number
  sdkFor: (directory: DirectoryRef) => QueryOptionsClient & Parameters<typeof bootstrapDirectory>[0]["sdk"]
  localSessionListClient: (directory: DirectoryRef) => SessionListClient
  setSessionLoadMeta: (directory: DirectoryRef, value: DirectorySessionLoadMeta) => void
  markGlobalBootstrapFresh: (baseUrl: string, harnessType?: string) => void
  replaceRuntimeWorkspaceRows: (input: {
    workspaceKey: string
    directory: DirectoryRef
    workspaceName?: string
    projectID: string
    rows: SessionInventoryRow[]
    total: number
  }) => void
}) {
  function permissionMapForTrim(sessions: SessionRow[]) {
    const permission: Parameters<typeof trimSessions>[1]["permission"] = {}
    for (const session of sessions) {
      const cached = queryClient.getQueryData<{ permissions: Parameters<typeof trimSessions>[1]["permission"][string] }>(
        shellDataKeys.sessionId(session.id, "requests"),
      )
      if (cached?.permissions.length) permission[session.id] = cached.permissions
    }
    return permission
  }

  async function loadSessions(
    directory: DirectoryRef,
    opts: DirectorySessionCacheRefreshOptions & { force?: boolean } = {},
  ) {
    const signedWorkspace = input.signedWorkspaceInfo(directory)
    const requestedWorkspace = opts.workspace ?? signedWorkspace
    const requestKey = sessionLoadRequestKey(directory)
    const pending = queryClient.getQueryState(requestKey)?.fetchStatus === "fetching"
    if (pending && !opts.force) {
      await queryClient.fetchQuery({ queryKey: requestKey, queryFn: async () => null })
      const settledMeta = queryClient.getQueryData<DirectorySessionLoadMeta>(sessionLoadMetaKey(directory))
      if (sessionLoadMetaMatchesWorkspace(settledMeta, requestedWorkspace)) return
    }

    input.children.pin(directory)
    const currentCache = () => input.children.sessionCache(directory)
    const currentLimit = () => input.sessionCacheLimit(directory, currentCache().limit)
    const inventory = input.sessionInventory().byWorkspace[workspaceScopedCacheKey({
      directory,
      workspaceId: requestedWorkspace?.workspaceId,
    })]
    const inventoryMatchesWorkspace = sessionInventoryMatchesWorkspace(inventory, requestedWorkspace)
    if (inventory && inventoryMatchesWorkspace && !opts.force && !(input.workspaceRuntimeRef(directory) && inventory.sessions.length === 0)) {
      const cache = currentCache()
      const limit = currentLimit()
      const rootSessions = mapInventoryToSessions(inventory.sessions)
      const childSessions = cache.session.filter((session) => !!session.parentID)
      const sessions = trimSessions([...rootSessions, ...childSessions], {
        limit,
        permission: permissionMapForTrim([...rootSessions, ...childSessions]),
      })
      const previous = cache.session.slice()
      cleanupDroppedSessionCaches(previous, sessions, directory)
      input.setSessionLoadMeta(directory, {
        limit,
        ...(requestedWorkspace ? { workspace: requestedWorkspace } : {}),
      })
      input.cacheSessions(directory, {
        limit,
        total: inventory.total,
        session: sessions,
      })
      input.children.unpin(directory)
      return
    }

    const meta = queryClient.getQueryData<DirectorySessionLoadMeta>(sessionLoadMetaKey(directory))
    const cachedLimit = currentLimit()
    if (meta && meta.limit >= cachedLimit && sessionLoadMetaMatchesWorkspace(meta, requestedWorkspace) && !opts.force) {
      const cache = currentCache()
      const next = trimSessions(cache.session, {
        limit: cachedLimit,
        permission: permissionMapForTrim(cache.session),
      })
      if (next.length !== cache.session.length || cache.limit !== cachedLimit) {
        const previous = cache.session.slice()
        cleanupDroppedSessionCaches(previous, next, directory)
        input.cacheSessions(directory, {
          limit: cachedLimit,
          total: cache.total,
          session: next,
        })
      }
      input.children.unpin(directory)
      return
    }

    const requestLimit = Math.max(cachedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const baseUrl = input.baseUrl()
    const runtimeTarget = bootstrapSessionRuntimeTarget({
      workspace: requestedWorkspace,
      runtimeRef: input.workspaceRuntimeRef(directory),
    })
    const runtimeSessionClient = runtimeTarget
      ? createAgentRuntimeClient({
          serverUrl: baseUrl,
          request: localLoopbackFetch(baseUrl) ?? authFetch,
          ...runtimeTarget,
        })
      : undefined
    const signedInventory = !runtimeSessionClient && shouldUseSignedControlPlaneInventory({
      hasSignedAccess: input.hasSignedAccess(),
      baseUrl,
      directory,
    })
    const sessionListClient = shouldUseLocalSessionListClient({ baseUrl, directory })
      ? input.localSessionListClient(directory)
      : input.globalSDK()

    await queryClient.fetchQuery({
      queryKey: requestKey,
      queryFn: async () => {
        await (signedInventory
          ? Promise.resolve({
              data: mapInventoryToSessions(await input.signedInventorySource.fetchSignedDirectorySessions(directory)),
              limit: requestLimit,
              limited: false,
            })
          : loadRootSessionsWithFallback({
              directory,
              limit: requestLimit,
              list: async (query) => {
                if (runtimeSessionClient) return { data: (await runtimeSessionClient.listSessions(query)).sessions ?? [] }
                if (shouldSkipCentralSessionList({ baseUrl, directory: query.directory })) {
                  return { data: [] }
                }
                return sessionListClient.session.list(query)
              },
            }))
          .then((result) => {
            const nonArchived = (result.data ?? [])
              .filter((session) => !!session?.id)
              .filter((session) => !session.time?.archived)
              .map((session) => runtimeSessionClient ? { ...session, directory } : session)
              .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
            const cache = currentCache()
            const limit = currentLimit()
            const childSessions = cache.session.filter((session) => !!session.parentID)
            const sessions = trimSessions([...nonArchived, ...childSessions], {
              limit,
              permission: permissionMapForTrim([...nonArchived, ...childSessions]),
            })
            const total = estimateRootSessionTotal({ count: nonArchived.length, limit: result.limit, limited: result.limited })
            const previous = cache.session.slice()
            cleanupDroppedSessionCaches(previous, sessions, directory)
            input.setSessionLoadMeta(directory, {
              limit,
              ...(requestedWorkspace ? { workspace: requestedWorkspace } : {}),
            })
            input.cacheSessions(directory, {
              limit,
              total,
              session: sessions,
            })
            if (!runtimeSessionClient) return
            const workspace = runtimeInventoryWorkspaceIdentity({
              directory,
              requestedWorkspace,
              signedWorkspace,
            })
            const workspaceSessions = nonArchived.map((session) => ({
              ...input.inventoryRow(session as InventoryGlobalSession),
              directory: workspace.directory,
              workspaceId: workspace.workspaceId,
              workspaceName: workspace.workspaceName,
            }))
            input.replaceRuntimeWorkspaceRows({
              workspaceKey: workspace.workspaceId,
              directory: workspace.directory,
              workspaceName: workspace.workspaceName,
              projectID: input.projectFor(workspace.directory)?.id ?? input.projectFor(directory)?.id ?? workspace.workspaceId,
              rows: workspaceSessions,
              total,
            })
          })
          .catch((err) => {
            if (opts.quiet) return
            const project = getFilename(directory)
            showToast({
              variant: "error",
              title: input.translate("toast.session.listFailed.title", { project }),
              description: formatServerError(err, input.translate),
            })
          })
        return null
      },
    }).finally(() => {
      queryClient.removeQueries({ queryKey: requestKey })
      input.children.unpin(directory)
    })
  }

  async function bootstrapInstance(
    directory: DirectoryRef,
    harnessType?: string,
    opts: DirectorySessionCacheRefreshOptions = {},
  ) {
    if (!directory) return
    const effectiveHarnessType = harnessType ?? (input.workspaceDirectoryRef(directory) ? "opencode" : undefined)
    const workspace = opts.workspace ?? input.signedWorkspaceInfo(directory)
    const requestKey = bootstrapRequestKey(directory, effectiveHarnessType, workspace)
    await queryClient.fetchQuery({
      queryKey: requestKey,
      queryFn: async () => {
        input.children.pin(directory)
        await bootstrapDirectory({
          directory,
          sdk: input.sdkFor(directory),
          loadSessions,
          translate: input.translate,
          fetch: input.platformFetch(),
          baseUrl: input.baseUrl(),
          harnessType: effectiveHarnessType,
          quiet: opts.quiet,
          workspace,
        })
        return null
      },
    }).finally(() => {
      queryClient.removeQueries({ queryKey: requestKey })
      input.children.unpin(directory)
    })
  }

  async function bootstrap(harnessType?: string, opts: { force?: boolean } = {}) {
    const requestKey = globalBootstrapRequestKey(input.baseUrl(), harnessType)
    const freshKey = globalBootstrapFreshKey(input.baseUrl(), harnessType)
    const pending = queryClient.getQueryState(requestKey)?.fetchStatus === "fetching"
    if (pending) {
      await queryClient.fetchQuery({ queryKey: requestKey, queryFn: async () => null })
      return
    }
    const updatedAt = queryClient.getQueryState(freshKey)?.dataUpdatedAt ?? 0
    if (!opts.force && input.ready() && updatedAt > 0 && Date.now() - updatedAt < 60_000) return
    const directory = input.initialRouteDirectory()
    const signedRoute = shouldUseSignedRouteBootstrap({
      signedRoute: false,
      baseUrl: input.baseUrl(),
      platformFetch: input.platformFetch(),
    })
    await queryClient.fetchQuery({
      queryKey: requestKey,
      queryFn: async () => {
        await bootstrapGlobal({
          baseUrl: input.baseUrl(),
          globalSDK: input.globalSDK(),
          fetch: signedRoute || shouldUseSignedControlPlaneInventory({
            hasSignedAccess: input.hasSignedAccess(),
            baseUrl: input.baseUrl(),
            directory,
          })
            ? input.platformFetch() ?? authFetch
            : globalBootstrapFetch(input.baseUrl(), input.platformFetch()),
          connectErrorTitle: input.translate("dialog.server.add.error"),
          connectErrorDescription: input.translate("error.globalSync.connectFailed", { url: input.baseUrl() }),
          requestFailedTitle: input.translate("common.requestFailed"),
          translate: input.translate,
          formatMoreCount: (count) => input.translate("common.moreCountSuffix", { count }),
          setGlobalState: input.setGlobalState,
          harnessType,
        })
        return null
      },
    }).finally(() => {
      queryClient.removeQueries({ queryKey: requestKey, exact: true })
      input.markGlobalBootstrapFresh(input.baseUrl(), harnessType)
    })
  }

  return {
    bootstrap,
    bootstrapInstance,
    loadSessions,
    queryOptionsApi: createQueryOptionsApi({
      globalSDK: input.globalSDK,
      sdkFor: input.sdkFor,
      baseUrl: input.baseUrl(),
      request: input.platformFetch() ?? authFetch,
    }),
    refreshDirectory(directory: DirectoryRef, harnessType?: string, opts?: DirectorySessionCacheRefreshOptions) {
      if (!directory) return Promise.resolve()
      return bootstrapInstance(directory, harnessType, opts)
    },
  }
}
