import { type Project, createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import type { InitError } from "@/app/routes/error"
import { createContext, useContext, onCleanup, onMount, createSignal, type ParentProps } from "solid-js"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useLanguage } from "@/platform/i18n/provider"
import { createRefreshQueue } from "@/platform/sync/global-sync/queue"
import { scheduleMarkdownPrewarm } from "@/ui/session-kit-loaders"
import { sanitizeProject } from "./project-sanitize"
import { projectForDirectory } from "./project-owner"
import { initialRouteDirectory, workspaceDirectoryRef } from "./bootstrap-scope"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { createDirectoryCacheManager } from "@/platform/sync/directory-cache-manager"
import { wasRolledBackDraft } from "../../../features/session/submit/rolled-back-drafts"
import type { GlobalBootstrapState } from "@/app/boot/data/bootstrap"
import { clearSessionPrefetchDirectory } from "@/platform/sync/session-prefetch"
import type { ProjectMeta, SessionInventoryRow, SessionCacheValue, WorkspaceGroup } from "@/features/session/data/sync/global-sync-types"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { SessionFilter } from "@/platform/sync/global-sync/session-filter"
import { GLOBAL_SESSION_PAGE_SIZE } from "@/platform/sync/global-sync/session-pagination"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { type SessionInventoryStoredValue, type SessionInventoryValue } from "../../../features/session/data/sync/queries"
import {
  applySessionInventoryLifecycle,
  createSessionInventorySnapshotValue,
  mergeSessionInventoryProjectPage,
  mergeSessionInventoryWorkspaceGroups,
  mergeSessionInventoryWorkspacePage,
  readSessionInventoryQueryData,
  removeSessionInventoryRow,
  replaceSessionInventoryWorkspaceGroups,
  replaceSessionInventoryWorkspaceRows,
  setSessionInventoryQueryData,
  updateSessionInventoryQueryData,
} from "../../../features/session/data/sync/inventory-writers"
import { migrateLegacyProjectInventoryToQueryCache } from "../../integrations/sync/project-inventory"
import { removeSessionIdentity } from "@/platform/sync/global-session-identity"
import {
  applyWorkspaceCatalog,
  readWorkspaceCatalog,
  refreshWorkspaceCatalog,
  workspaceCatalogQueryKey,
} from "@/features/workspaces/data/workspace-catalog"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import {
  cachedGlobalSyncSdkClient,
  clearGlobalSyncSdkClientsForDirectory,
  clearGlobalSyncSdkClientsForOwner,
} from "@/platform/sync/global-sync-sdk-client-cache"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"
import { createTransport } from "@/platform/runtime/transport"
import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { principalDataScope, principalHasSignedAccess, usePrincipal } from "@/platform/auth/identity-provider"
import { centralTransportForServer, unsignedLocalFetch } from "@/platform/runtime/transport"
import { sessionLoadMetaKey, setDirectorySessionCache, type DirectorySessionCacheRefreshOptions } from "../../../features/session/data/sync/directory-session-cache"
import { useClaxedoEventsOptional } from "../../integrations/claxedo-events"
import { bootstrapRequestPrefix, createBootstrapOrchestrator, globalBootstrapFreshKey, sessionLoadRequestKey, type QueryOptionsApi } from "../../boot/data/bootstrap-orchestrator"
import {
  createGlobalSyncEventIngress,
  createSessionAccessRevocationChannel,
  createSessionAuthorityRevision,
  reconcileAuthorizedSessionPersistence,
} from "../../integrations/session-events/event-ingress"
import { useSessionTitleProjection } from "@/features/session/providers/session-title-projection-provider"
import { bootstrapInitialShell } from "./shell-bootstrap"
import {
  createInventoryPageSource,
  createSignedInventorySource,
  type InventoryGlobalSession,
  mergeWorkspaceGroups,
  shouldUseSignedControlPlaneInventory,
  shouldUseSignedProjectSessionInventory,
  shouldUseSignedSessionInventory,
  toSessionInventoryRow,
  workspaceGroupKey,
} from "../../../features/session/data/sync/inventory-source"
export { shouldUseSignedControlPlaneInventory, shouldUseSignedProjectSessionInventory, shouldUseSignedSessionInventory } from "../../../features/session/data/sync/inventory-source"
const GLOBAL_TAG = "global"
const GLOBAL_SHOW_TAG = "global:default"
const PAGE = GLOBAL_SESSION_PAGE_SIZE

function createGlobalSync(input: { flushNavigationPersistence: () => Promise<void> }) {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const principal = usePrincipal()
  const sessionTitles = useSessionTitleProjection()
  // A browser surface alone is not signed authority: local/mock browser lanes
  // are web too. Inventory predicates further narrow this principal capability
  // to an explicit relay-backed project, route, or non-loopback control plane.
  const hasSignedAccess = () => principalHasSignedAccess(principal())
  const principalScope = () => principalDataScope(principal())
  const claxedoEvents = useClaxedoEventsOptional()
  const sessionAccessRevocations = createSessionAccessRevocationChannel()
  const sessionAuthorityRevision = createSessionAuthorityRevision()
  const sdkClientCacheOwner = Math.random().toString(36).slice(2, 7)

  const sessionInventory = () => readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: globalSDK.url })
  const publishSessionTitles = () => sessionTitles.replaceInventory(sessionInventory().sessions)
  const setSessionInventory = (value: SessionInventoryStoredValue<SessionInventoryRow> | SessionInventoryValue<SessionInventoryRow>) => {
    setSessionInventoryQueryData({ baseUrl: globalSDK.url, value })
    publishSessionTitles()
  }
  const updateSessionInventory = (
    mutate: (draft: SessionInventoryValue<SessionInventoryRow>) => void,
  ) => {
    updateSessionInventoryQueryData({ baseUrl: globalSDK.url, mutate })
    publishSessionTitles()
  }
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<InitError | undefined>()
  const [reload, setReload] = createSignal<undefined | "pending" | "complete">()
  migrateLegacyProjectInventoryToQueryCache<Project>({
    cache: {
      read: () => queryClient.getQueryData<Project[]>(workspaceCatalogQueryKey(globalSDK.url)),
      write: (value) => applyWorkspaceCatalog({ baseUrl: globalSDK.url, next: value }),
    },
    sanitize: sanitizeProject,
  })
  const projects = () => readWorkspaceCatalog(globalSDK.url)
  const catalogInput = () => ({
    baseUrl: globalSDK.url,
    client: globalSDK.client,
    request: platform.fetch,
    signedAccess: hasSignedAccess(),
  })
  const setGlobalState = (patch: Partial<GlobalBootstrapState>) => {
    if ("ready" in patch) setReady(!!patch.ready)
    if ("error" in patch) setError(patch.error as InitError | undefined)
    if (patch.path) queryClient.setQueryData(queryKeys.directory.path(globalSDK.url, ""), patch.path)
    if ("reload" in patch) setReload(patch.reload)
  }

  function projectFor(directory: string) {
    return projectForDirectory(projects(), directory)
  }
  function inventoryRow(session: InventoryGlobalSession) {
    return toSessionInventoryRow(session, { projectID: projectFor(session.directory)?.id })
  }
  function isGlobal(item: Pick<SessionInventoryRow, "tags">) {
    return item.tags.includes(GLOBAL_TAG)
  }
  function showGlobal(item: Pick<SessionInventoryRow, "tags">) {
    return item.tags.includes(GLOBAL_SHOW_TAG)
  }
  function signedWorkspaceProjects() {
    return projects().filter((project) =>
      shouldUseSignedProjectSessionInventory({
        hasSignedAccess: hasSignedAccess(),
        baseUrl: globalSDK.url,
        project: project as Project & {
          workspaces?: Record<string, { kind?: string }>
        },
      })
    )
  }

  function signedWorkspaceInfo(key: string) {
    return signedWorkspaceFromProjects(projects(), key)
  }

  function workspaceScopeKey(directory: string) {
    return signedWorkspaceInfo(directory)?.workspaceId ??
      sessionWorkspaceRuntimeRef({ directory })?.workspaceId ??
      directory
  }

  function workspaceInventoryKey(directory: string) {
    const scopeKey = workspaceScopeKey(directory)
    if (sessionInventory().byWorkspace[scopeKey] || sessionInventory().workspaceState[scopeKey]) return scopeKey
    if (sessionInventory().byWorkspace[directory] || sessionInventory().workspaceState[directory]) return directory
    return Object.entries(sessionInventory().byWorkspace).find(([, group]) =>
      group.directory === directory ||
      group.workspaceId === directory ||
      group.key === directory
    )?.[0] ?? scopeKey
  }

  const signedInventorySource = createSignedInventorySource({
    queryClient,
    baseUrl: () => getClaxedoServerUrl(),
    owner: principalScope,
    authFetch,
    signedWorkspaceInfo,
    resolveWorkspace: async ({ directory }) =>
      await resolveWorkspaceRuntime({
        baseUrl: globalSDK.url,
        request: platform.fetch,
        directory,
      }) ?? undefined,
  })
  const {
    fetchGlobalList,
    fetchWorkspaceGrouped,
    fetchWorkspacePage,
  } = createInventoryPageSource({
    baseUrl: () => globalSDK.url,
    pageSize: PAGE,
    platformFetch: () => platform.fetch,
    authFetch,
    queryClient,
    hasSignedAccess,
    signedWorkspaceProjects,
    signedInventorySource,
  })

  async function loadSessionInventorySnapshot() {
    const scope = principalScope()
    const isCurrent = sessionAuthorityRevision.capture(() => principalScope() === scope)
    const inventory = sessionInventory()
    if (inventory.loaded || inventory.loading) return
    updateSessionInventory((draft) => {
      draft.loading = true
    })
    try {
      const useSignedSnapshot = shouldUseSignedSessionInventory({
        hasSignedAccess: hasSignedAccess(),
        signedRoute: false,
        baseUrl: globalSDK.url,
      }) || signedWorkspaceProjects().length > 0
      const signedSnapshot = useSignedSnapshot
        ? await signedInventorySource.fetchSignedWorkspaceSnapshot()
        : { groups: [] as WorkspaceGroup[] }
      if (!isCurrent()) throw new Error("Session authority changed during inventory load")
      if (useSignedSnapshot && centralTransportForServer(globalSDK.url) !== "loopback") {
        const snapshot = signedSnapshot
        const wsResult = snapshot.groups
        reconcileAuthorizedSessionPersistence(wsResult.flatMap((group) => group.sessions), scope)
        const byWorkspace = Object.fromEntries(wsResult.map((group) => [workspaceGroupKey(group), group] as const))
        const workspaceState = Object.fromEntries(wsResult.map((group) => [
          workspaceGroupKey(group),
          {
            hasMore: group.hasMore,
            loading: false,
            cursor: group.nextCursor,
          },
        ] as const))
        setSessionInventory(createSessionInventorySnapshotValue({
          groups: byWorkspace,
          workspaceState,
          workspaceOrder: wsResult.map(workspaceGroupKey),
          loaded: true,
        }))
        return
      }
      const [flatResult, wsResult] = await Promise.all([
        fetchGlobalList({ limit: 100 }),
        fetchWorkspaceGrouped({ perGroup: PAGE }),
      ])
      if (!isCurrent()) throw new Error("Session authority changed during inventory load")
      const combinedWorkspaceResult = mergeWorkspaceGroups(wsResult, signedSnapshot.groups)
      reconcileAuthorizedSessionPersistence(
        combinedWorkspaceResult.flatMap((group) => group.sessions),
        scope,
      )
      const sessions = flatResult.data.filter((s) => !!s?.id && !s.parentID)
      const cursor = flatResult.cursor

      const rows = sessions.flatMap((s) => {
        const item = inventoryRow(s)
        if (isGlobal(item)) {
          return showGlobal(item) ? [item] : []
        }
        return [item]
      })

      // Build workspace-level stores
      const byWorkspace: Record<string, WorkspaceGroup> = {}
      const workspaceState: Record<string, { hasMore: boolean; loading: boolean; cursor?: number }> = {}
      const workspaceOrder: string[] = []
      for (const g of combinedWorkspaceResult) {
        const wsSessions = (g.sessions ?? [])
          .filter((s) => !!s.id)
          .sort((a: SessionInventoryRow, b: SessionInventoryRow) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
        const key = workspaceGroupKey(g)
        byWorkspace[key] = {
          key,
          directory: g.directory,
          workspaceId: g.workspaceId,
          workspaceName: g.workspaceName,
          projectID: g.projectID,
          sessions: wsSessions,
          hasMore: g.hasMore,
          total: g.total,
          nextCursor: typeof g.nextCursor === "number" ? g.nextCursor : undefined,
        }
        workspaceState[key] = {
          hasMore: g.hasMore,
          loading: false,
          cursor:
            typeof g.nextCursor === "number"
              ? g.nextCursor
              : g.hasMore
                ? wsSessions.at(-1)?.time.updated
                : undefined,
        }
        workspaceOrder.push(key)
      }

      const projectIDs = new Set([
        ...rows.flatMap((row) => row.projectID ? [row.projectID] : []),
        ...Object.values(byWorkspace).map((group) => group.projectID),
      ])
      setSessionInventory(createSessionInventorySnapshotValue({
        rows,
        groups: byWorkspace,
        workspaceState,
        workspaceOrder,
        projectState: cursor
          ? Object.fromEntries([...projectIDs].map((pid) => [pid, { hasMore: true, loading: false, cursor: undefined }]))
          : {},
        loaded: true,
        ...(cursor ? { initialCursor: Number(cursor) } : {}),
      }))
    } catch {
      if (principalScope() !== scope) return
      updateSessionInventory((draft) => {
        draft.loading = false
      })
    }
  }

  async function reloadWorkspaceGroups(filter?: SessionFilter) {
    const scope = principalScope()
    const isCurrent = sessionAuthorityRevision.capture(() => principalScope() === scope)
    try {
      const wsResult = await fetchWorkspaceGrouped({ perGroup: PAGE, filter })
      if (!isCurrent()) return
      reconcileAuthorizedSessionPersistence(wsResult.flatMap((group) => group.sessions), scope)
      const byWorkspace: Record<string, WorkspaceGroup> = {}
      const workspaceState: Record<string, { hasMore: boolean; loading: boolean; cursor?: number }> = {}
      const workspaceOrder: string[] = []
      for (const g of wsResult) {
        const wsSessions = (g.sessions ?? [])
          .filter((s) => !!s?.id)
          .sort((a: SessionInventoryRow, b: SessionInventoryRow) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
        const key = workspaceGroupKey(g)
        byWorkspace[key] = {
          key,
          directory: g.directory,
          workspaceId: g.workspaceId,
          workspaceName: g.workspaceName,
          projectID: g.projectID,
          sessions: wsSessions,
          hasMore: g.hasMore,
          total: g.total,
          nextCursor: typeof g.nextCursor === "number" ? g.nextCursor : undefined,
        }
        workspaceState[key] = {
          hasMore: g.hasMore,
          loading: false,
          cursor:
            typeof g.nextCursor === "number"
              ? g.nextCursor
              : g.hasMore
                ? wsSessions.at(-1)?.time.updated
                : undefined,
        }
        workspaceOrder.push(key)
      }
      updateSessionInventory((draft) => {
        if (filter) {
          mergeSessionInventoryWorkspaceGroups(draft, {
            groups: byWorkspace,
            workspaceState,
          })
          return
        }
        replaceSessionInventoryWorkspaceGroups(draft, {
          groups: byWorkspace,
          workspaceState,
          workspaceOrder,
        })
      })
    } catch {
    }
  }

  async function loadMoreForProject(projectID: string, projectWorktree: string, sandboxes: string[]) {
    const scope = principalScope()
    const isCurrent = sessionAuthorityRevision.capture(() => principalScope() === scope)
    const pState = sessionInventory().projectState[projectID]
    if (pState?.loading) return

    updateSessionInventory((draft) => {
      draft.projectState[projectID] = {
        hasMore: pState?.hasMore ?? true,
        loading: true,
        cursor: pState?.cursor,
      }
    })

    try {
      const directories = [projectWorktree, ...sandboxes.filter((s) => s !== projectWorktree)]
      let projectHasMore = false

      for (const dir of directories) {
        const key = workspaceInventoryKey(dir)
        const workspaceState = sessionInventory().workspaceState[key]
        const workspaceGroup = sessionInventory().byWorkspace[key]
        const result = await fetchWorkspacePage(dir, {
          limit: PAGE,
          cursor: workspaceState?.cursor ?? workspaceGroup?.nextCursor,
        })
        if (!isCurrent()) return
        const sessions = result.data.filter((s) => !!s?.id && !s.parentID)
        reconcileAuthorizedSessionPersistence(sessions, scope)
        const cursor = result.cursor
        projectHasMore ||= !!cursor

        updateSessionInventory((draft) => {
          mergeSessionInventoryProjectPage(draft, {
            projectID,
            workspaceKey: key,
            directory: dir,
            rows: sessions.map((s) => inventoryRow(s)),
            cursor,
          })
        })
      }
      updateSessionInventory((draft) => {
        if (!draft.projectState[projectID]) {
          draft.projectState[projectID] = { hasMore: false, loading: false, cursor: undefined }
        }
        draft.projectState[projectID].hasMore = projectHasMore
      })
    } catch {
    } finally {
      if (principalScope() !== scope) return
      updateSessionInventory((draft) => {
        if (!draft.projectState[projectID]) return
        draft.projectState[projectID].loading = false
      })
    }
  }

  async function loadMoreForWorkspace(directory: string, filter?: SessionFilter) {
    const scope = principalScope()
    const isCurrent = sessionAuthorityRevision.capture(() => principalScope() === scope)
    const key = workspaceInventoryKey(directory)
    const wState = sessionInventory().workspaceState[key]
    if (wState?.loading) return

    updateSessionInventory((draft) => {
      draft.workspaceState[key] = {
        hasMore: wState?.hasMore ?? true,
        loading: true,
        cursor: wState?.cursor,
      }
    })

    try {
      const result = await fetchWorkspacePage(directory, { limit: PAGE, filter, cursor: wState?.cursor })
      if (!isCurrent()) return
      const sessions = result.data.filter((s) => !!s?.id && !s.parentID)
      reconcileAuthorizedSessionPersistence(sessions, scope)
      const cursor = result.cursor

      updateSessionInventory((draft) => {
        mergeSessionInventoryWorkspacePage(draft, {
          workspaceKey: key,
          directory,
          rows: sessions.map((s) => inventoryRow(s)),
          cursor,
        })
      })
    } catch {
    } finally {
      if (principalScope() !== scope) return
      updateSessionInventory((draft) => {
        if (!draft.workspaceState[key]) return
        draft.workspaceState[key].loading = false
      })
    }
  }

  function applySessionEventToGlobal(info: Session, type: "created" | "updated" | "deleted") {
    updateSessionInventory((draft) => {
      applySessionInventoryLifecycle(draft, info, type)
    })
  }

  function dropGlobalSession(input: { id: string; directory: string; projectID?: string; tags?: string[] }) {
    updateSessionInventory((draft) => {
      removeSessionInventoryRow(draft, input)
    })
  }

  const paused = () => reload() !== undefined
  let bootstrapOrchestrator: ReturnType<typeof createBootstrapOrchestrator> | undefined

  function bootstrap(harnessType?: string, opts: { force?: boolean } = {}) {
    if (!bootstrapOrchestrator) return Promise.resolve()
    return bootstrapOrchestrator.bootstrap(harnessType, opts)
  }

  function bootstrapInstance(directory: string, harnessType?: string, opts: DirectorySessionCacheRefreshOptions = {}) {
    if (!bootstrapOrchestrator) return Promise.resolve()
    return bootstrapOrchestrator.bootstrapInstance(directory, harnessType, opts)
  }

  function refreshDirectory(directory: Parameters<typeof bootstrapInstance>[0], harnessType?: string, opts?: DirectorySessionCacheRefreshOptions) {
    if (!bootstrapOrchestrator) return Promise.resolve()
    return bootstrapOrchestrator.refreshDirectory(directory, harnessType, opts)
  }

  const queue = createRefreshQueue({
    paused,
    bootstrap,
    bootstrapInstance,
  })

  const children = createDirectoryCacheManager({
    isBooting: (directory) =>
      queryClient.getQueryCache().findAll({ queryKey: bootstrapRequestPrefix(directory) }).length > 0,
    isLoadingSessions: (directory) => !!queryClient.getQueryData(sessionLoadRequestKey(directory)),
    onDispose: (directory) => {
      queue.clear(directory)
      queryClient.removeQueries({ queryKey: sessionLoadRequestKey(directory) })
      queryClient.removeQueries({ queryKey: sessionLoadMetaKey(directory) })
      clearGlobalSyncSdkClientsForDirectory({ owner: sdkClientCacheOwner, directory })
      clearSessionPrefetchDirectory(directory)
    },
    resolveScopeKey: workspaceScopeKey,
    translate: language.t,
  })

  const sdkFor = (directory: string) => {
    const workspace = signedWorkspaceInfo(directory)
    const workspaceId = workspace?.workspaceId ?? sessionWorkspaceRuntimeRef({ directory })?.workspaceId
    const request = platform.fetch ?? authFetch
    return cachedGlobalSyncSdkClient({
      owner: sdkClientCacheOwner,
      serverUrl: globalSDK.url,
      directory,
      workspaceId,
      create: () => createOpencodeClient({
        baseUrl: globalSDK.url,
        fetch: workspaceId
          ? createTransport({
              placement: {
                workspaceId,
                hosting: "workspace",
                // `workspaceId` came only from signed inventory or a canonical
                // workspace ref. Placement therefore targets the relay even
                // while principal hydration is pending; the relay authorizes.
                transport: "workspace-relay",
              },
              serverUrl: globalSDK.url,
              directory,
              workspace: workspace ?? { kind: "cloud", workspaceId },
              request,
              relayRequest: request,
            }).sdkFetch
          : platform.fetch,
        directory,
        throwOnError: true,
      }),
    })
  }

  bootstrapOrchestrator = createBootstrapOrchestrator({
    baseUrl: () => globalSDK.url,
    globalSDK: () => globalSDK.client,
    children,
    translate: language.t,
    platformFetch: () => platform.fetch,
    ready,
    setGlobalState,
    initialRouteDirectory,
    hasSignedAccess,
    workspaceDirectoryRef,
    workspaceRuntimeRef: (directory) => sessionWorkspaceRuntimeRef({ directory, projects: projects() }),
    signedWorkspaceInfo,
    signedInventorySource,
    sessionInventory: () => sessionInventory(),
    projectFor,
    inventoryRow,
    cacheSessions,
    sessionCacheLimit,
    sdkFor,
    localSessionListClient: (directory) => createOpencodeClient({
      baseUrl: globalSDK.url,
      fetch: unsignedLocalFetch,
      directory,
      throwOnError: true,
    }),
    setSessionLoadMeta: (directory, value) => queryClient.setQueryData(sessionLoadMetaKey(directory), value),
    markGlobalBootstrapFresh: (baseUrl, harnessType) => queryClient.setQueryData(globalBootstrapFreshKey(baseUrl, harnessType), true),
    replaceRuntimeWorkspaceRows: (input) => {
      updateSessionInventory((draft) => {
        replaceSessionInventoryWorkspaceRows(draft, input)
      })
    },
  })
  const queryOptionsApi = bootstrapOrchestrator.queryOptionsApi

  function cacheSessions(directory: string, value: Omit<SessionCacheValue, "at">) {
    const next = {
      ...value,
      at: Date.now(),
    }
    for (const alias of children.aliasesFor(directory)) {
      setDirectorySessionCache(alias, next)
    }
  }

  function sessionCacheLimit(directory: string, fallback: number) {
    const key = workspaceScopeKey(directory)
    return Math.max(
      queryClient.getQueryData<SessionCacheValue>(queryKeys.directory.sessionCache(key))?.limit ?? 0,
      queryClient.getQueryData<SessionCacheValue>(queryKeys.directory.sessionCache(directory))?.limit ?? 0,
      fallback,
    )
  }

  onCleanup(createGlobalSyncEventIngress({
    globalEvents: globalSDK.event,
    claxedoEvents,
    projects,
    projectFor,
    children,
    push: queue.push,
    // `global.disposed` / `server.connected` mean the whole global surface
    // changed underneath us: re-run the queued bootstraps AND re-read the
    // catalog from its own sources.
    refresh: () => {
      queue.refresh()
      void refreshWorkspaceCatalog(catalogInput())
    },
    setGlobalProject: (next) => applyWorkspaceCatalog({ baseUrl: globalSDK.url, next }),
    sessionInventoryLoaded: () => sessionInventory().loaded,
    applySessionEvent: applySessionEventToGlobal,
    sessionTitles: {
      publishCanonical: sessionTitles.publishCanonical,
      remove: sessionTitles.remove,
    },
    draftWasRolledBack: wasRolledBackDraft,
    cacheSessions,
    sessionCacheLimit,
    sessionAccessRetained: signedInventorySource.hasControlPlaneSessionAccess,
    revocationScope: principalScope,
    onSessionAuthorityChanged: sessionAuthorityRevision.invalidate,
    onSessionAccessRevoked: sessionAccessRevocations.publish,
    flushNavigationPersistence: input.flushNavigationPersistence,
  }))
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of children.directories()) {
      children.disposeDirectory(directory)
    }
    clearGlobalSyncSdkClientsForOwner(sdkClientCacheOwner)
  })

  onMount(() => {
    queueMicrotask(() => {
      void globalSDK.event.start()
    })
    const loopback = centralTransportForServer(globalSDK.url) === "loopback"
    void (loopback
      ? bootstrapInitialShell({ baseUrl: globalSDK.url, request: globalThis.fetch, setGlobalState, fallback: bootstrap })
      : bootstrap())
    onCleanup(scheduleMarkdownPrewarm())
  })

  function projectMeta(directory: string, patch: ProjectMeta) {
    children.projectMeta(directory, patch)
  }

  function projectIcon(directory: string, value: string | undefined) {
    children.projectIcon(directory, value)
  }

  const sessionInventoryActions = {
    load: loadSessionInventorySnapshot,
    reloadWorkspace: reloadWorkspaceGroups,
    loadMore: loadMoreForProject,
    loadMoreWorkspace: loadMoreForWorkspace,
    drop: dropGlobalSession,
  }

  return {
    get ready() {
      return ready()
    },
    get error() {
      return error()
    },
    queryOptions: queryOptionsApi,
    bootstrap,
    refreshDirectory,
    // Tells the bootstrap queue which workspace the user is currently
    // focused on, so its hydration is prioritized over any background
    // refresh. Has no effect if the directory isn't queued. Caller should
    // invoke this on URL changes / workspace switches.
    setFocusedDirectory(directory: string | undefined) {
      queue.setFocused(directory)
    },
    onSessionAccessRevoked: sessionAccessRevocations.subscribe,
    inventoryActions: sessionInventoryActions,
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps<{ flushNavigationPersistence: () => Promise<void> }>) {
  const value = createGlobalSync({ flushNavigationPersistence: props.flushNavigationPersistence })
  // Children mount immediately instead of waiting on `value.ready` (the
  // bootstrap fetch, already kicked off unconditionally above). Readers that
  // care use `useGlobalShellReady()` (layout.tsx, app-shell-state.ts); every
  // other reader goes through TanStack Query, which handles a pending first
  // fetch on its own. This removed a boot dependency stage with no real data need.
  return <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}

export function useQueryOptions() {
  return useGlobalSync().queryOptions
}
