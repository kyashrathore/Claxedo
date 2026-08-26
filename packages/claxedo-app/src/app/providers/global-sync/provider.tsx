import { type Project, createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import type { InitError } from "@/app/routes/error"
import {
  createContext,
  useContext,
  onCleanup,
  onSettled,
  createSignal,
  type ParentProps,
  Switch,
  Match,
} from "solid-js"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useLanguage } from "@/platform/i18n/provider"
import { createRefreshQueue } from "@/platform/sync/global-sync/queue"
import { scheduleMarkdownPrewarm } from "@/ui/session-kit-loaders"
import { scheduleUserExtensionLoad } from "@/platform/extensions/user-extensions"
import { sanitizeProject } from "./project-sanitize"
import { projectForDirectory } from "./project-owner"

function workspaceDirectoryRef(directory: string) {
  return !!workspaceRuntimeRef(directory)
}

const workspaceRuntimeRef = (directory: string) => sessionWorkspaceRuntimeRef({ directory })

import { createDirectoryCacheManager } from "@/platform/sync/directory-cache-manager"
import { wasRolledBackDraft } from "../../../features/session/submit/rolled-back-drafts"
import type { GlobalBootstrapState } from "@/app/boot/data/bootstrap"
import { clearSessionPrefetchDirectory } from "@/platform/sync/session-prefetch"
import type {
  ProjectMeta,
  SessionInventoryRow,
  SessionCacheValue,
  WorkspaceGroup,
} from "@/features/session/data/sync/global-sync-types"
import { SESSION_RECENT_LIMIT } from "@/features/session/data/sync/global-sync-types"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { SessionFilter } from "@/platform/sync/global-sync/session-filter"
import { GLOBAL_SESSION_PAGE_SIZE } from "@/platform/sync/global-sync/session-pagination"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { setProviderQueryData } from "@/platform/query/provider-cache"
import {
  type SessionInventoryStoredValue,
  type SessionInventoryValue,
} from "../../../features/session/data/sync/queries"
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
import { shellRouteDirectoryFromPathname } from "@/platform/identity/route"
import { removeSessionIdentity } from "@/platform/sync/global-session-identity"
import { mergeSignedInventoryProjects } from "../../../features/session/data/query/inventory"
import { projectListQuery } from "@/platform/query/control-plane"
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
import { principalHasSignedAccess, usePrincipal } from "@/platform/auth/identity-provider"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { centralTransportForServer, unsignedLocalFetch } from "@/platform/runtime/transport"
import {
  sessionLoadMetaKey,
  setDirectorySessionCache,
  type DirectorySessionCacheRefreshOptions,
} from "../../../features/session/data/sync/directory-session-cache"
import { useClaxedoEventsOptional } from "../../integrations/claxedo-events"
import {
  bootstrapRequestPrefix,
  createBootstrapOrchestrator,
  globalBootstrapFreshKey,
  sessionLoadRequestKey,
  type QueryOptionsApi,
} from "../../boot/data/bootstrap-orchestrator"
import { createGlobalSyncEventIngress } from "../../integrations/session-events/event-ingress"
import { bootstrapInitialShell } from "./shell-bootstrap"
import {
  createInventoryPageSource,
  createSignedInventorySource,
  listSignedWorkspaceRuntimeSessions,
  type InventoryGlobalSession,
  mergeWorkspaceGroups,
  shouldUseSignedControlPlaneInventory,
  shouldUseSignedProjectSessionInventory,
  shouldUseSignedSessionInventory,
  toSessionInventoryRow,
  workspaceGroupKey,
} from "../../../features/session/data/sync/inventory-source"

export {
  shouldUseSignedControlPlaneInventory,
  shouldUseSignedProjectSessionInventory,
  shouldUseSignedSessionInventory,
} from "../../../features/session/data/sync/inventory-source"

const GLOBAL_TAG = "global"
const GLOBAL_SHOW_TAG = "global:default"
const PAGE = GLOBAL_SESSION_PAGE_SIZE

function initialRouteDirectory() {
  if (typeof window === "undefined") return
  const configured = (
    window as typeof window & {
      __OPENCODE__?: { activeDirectory?: string }
    }
  ).__OPENCODE__?.activeDirectory
  if (configured) return configured
  return shellRouteDirectoryFromPathname(window.location.pathname)
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const principal = usePrincipal()
  // A browser surface alone is not signed authority: local/mock browser lanes
  // are web too. Inventory predicates further narrow this principal capability
  // to an explicit relay-backed project, route, or non-loopback control plane.
  const hasSignedAccess = () => principalHasSignedAccess(principal())
  const claxedoEvents = useClaxedoEventsOptional()

  const sdkClientCacheOwner = Math.random().toString(36).slice(2, 7)

  const sessionInventory = () => readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: globalSDK.url })
  const setSessionInventory = (
    value: SessionInventoryStoredValue<SessionInventoryRow> | SessionInventoryValue<SessionInventoryRow>,
  ) => setSessionInventoryQueryData({ baseUrl: globalSDK.url, value })
  const updateSessionInventory = (mutate: (draft: SessionInventoryValue<SessionInventoryRow>) => void) =>
    updateSessionInventoryQueryData({ baseUrl: globalSDK.url, mutate })
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<InitError | undefined>()
  const [reload, setReload] = createSignal<undefined | "pending" | "complete">()
  const projectQueryKey = queryKeys.controlPlane.projects(globalSDK.url)
  migrateLegacyProjectInventoryToQueryCache<Project>({
    cache: {
      read: () => queryClient.getQueryData<Project[]>(projectQueryKey),
      write: (value) => queryClient.setQueryData(projectQueryKey, value),
    },
    sanitize: sanitizeProject,
  })
  const projects = () => queryClient.getQueryData<Project[]>(projectQueryKey) ?? []
  const setGlobalState = (patch: Partial<GlobalBootstrapState>) => {
    if ("ready" in patch) setReady(!!patch.ready)
    if ("error" in patch) setError(patch.error as InitError | undefined)
    if (patch.path) queryClient.setQueryData(queryKeys.directory.path(globalSDK.url, ""), patch.path)
    if (patch.project) setProjects(patch.project)
    if (patch.provider) setProviderQueryData(queryKeys.controlPlane.providers(globalSDK.url), patch.provider)
    if (patch.provider_auth)
      queryClient.setQueryData(queryKeys.controlPlane.providerAuth(globalSDK.url), patch.provider_auth)
    if (patch.config) queryClient.setQueryData(["global", globalSDK.url ?? "", "config"], patch.config)
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
      }),
    )
  }

  function signedWorkspaceInfo(key: string) {
    return signedWorkspaceFromProjects(projects(), key)
  }

  function workspaceScopeKey(directory: string) {
    return signedWorkspaceInfo(directory)?.workspaceId ?? workspaceRuntimeRef(directory)?.workspaceId ?? directory
  }

  function workspaceInventoryKey(directory: string) {
    const scopeKey = workspaceScopeKey(directory)
    if (sessionInventory().byWorkspace[scopeKey] || sessionInventory().workspaceState[scopeKey]) return scopeKey
    if (sessionInventory().byWorkspace[directory] || sessionInventory().workspaceState[directory]) return directory
    return (
      Object.entries(sessionInventory().byWorkspace).find(
        ([, group]) => group.directory === directory || group.workspaceId === directory || group.key === directory,
      )?.[0] ?? scopeKey
    )
  }

  const signedInventorySource = createSignedInventorySource({
    queryClient,
    baseUrl: () => getClaxedoServerUrl(),
    snapshotBaseUrl: () => globalSDK.url,
    owner: () => {
      const identity = principal()
      if (identity.kind === "signed") return identity.userId
      if (identity.kind === "org-member") return `${identity.userId}:${identity.orgId}`
      return identity.kind
    },
    authFetch,
    signedWorkspaceInfo,
    resolveWorkspace: async ({ directory }) =>
      (await resolveWorkspaceRuntime({
        baseUrl: globalSDK.url,
        request: platform.fetch,
        directory,
      })) ?? undefined,
    // Only consulted when the control plane returned no sessions, to decide
    // whether probing that workspace's runtime can still help. Query-cached.
    workspaceStatus: async (scope) =>
      (await resolveWorkspaceRuntime({ baseUrl: globalSDK.url, request: platform.fetch, ...scope }))?.status,
    runtimeSessions: (input) => {
      if (!input.kind)
        throw new Error(`Signed runtime session inventory requires a workspace kind for ${input.workspaceId}`)
      return listSignedWorkspaceRuntimeSessions({
        serverUrl: globalSDK.url,
        request: authFetch,
        ...input,
        kind: input.kind,
        limit: SESSION_RECENT_LIMIT,
      })
    },
  })
  const { fetchGlobalList, fetchWorkspaceGrouped, fetchWorkspacePage } = createInventoryPageSource({
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
    const inventory = sessionInventory()
    if (inventory.loaded || inventory.loading) return
    updateSessionInventory((draft) => {
      draft.loading = true
    })
    try {
      const useSignedSnapshot =
        shouldUseSignedSessionInventory({
          hasSignedAccess: hasSignedAccess(),
          signedRoute: false,
          baseUrl: globalSDK.url,
        }) || signedWorkspaceProjects().length > 0
      const signedSnapshot = useSignedSnapshot
        ? await signedInventorySource
            .fetchSignedWorkspaceSnapshot()
            .catch(() => ({ projects: [], groups: [] as WorkspaceGroup[] }))
        : { projects: [], groups: [] as WorkspaceGroup[] }
      if (
        (signedSnapshot.projects.length > 0 || signedWorkspaceProjects().length > 0) &&
        centralTransportForServer(globalSDK.url) !== "loopback"
      ) {
        const snapshot =
          signedSnapshot.projects.length > 0
            ? signedSnapshot
            : await signedInventorySource.fetchSignedWorkspaceSnapshot()
        const wsResult = snapshot.groups
        if (snapshot.projects.length > 0) {
          setProjects((projects) => mergeSignedInventoryProjects(projects, snapshot.projects))
        }
        const byWorkspace = Object.fromEntries(wsResult.map((group) => [workspaceGroupKey(group), group] as const))
        const workspaceState = Object.fromEntries(
          wsResult.map(
            (group) =>
              [
                workspaceGroupKey(group),
                {
                  hasMore: group.hasMore,
                  loading: false,
                  cursor: group.nextCursor,
                },
              ] as const,
          ),
        )
        setSessionInventory(
          createSessionInventorySnapshotValue({
            groups: byWorkspace,
            workspaceState,
            workspaceOrder: wsResult.map(workspaceGroupKey),
            loaded: true,
          }),
        )
        return
      }
      const [flatResult, wsResult] = await Promise.all([
        fetchGlobalList({ limit: 100 }),
        fetchWorkspaceGrouped({ perGroup: PAGE }),
      ])
      const combinedWorkspaceResult = mergeWorkspaceGroups(wsResult, signedSnapshot.groups)
      const sessions = flatResult.data.filter((s) => !!s?.id && !s.parentID)
      const cursor = flatResult.cursor

      if (signedSnapshot.projects.length > 0) {
        setProjects((projects) => mergeSignedInventoryProjects(projects, signedSnapshot.projects))
      }
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
            typeof g.nextCursor === "number" ? g.nextCursor : g.hasMore ? wsSessions.at(-1)?.time.updated : undefined,
        }
        workspaceOrder.push(key)
      }

      const projectIDs = new Set([
        ...rows.flatMap((row) => (row.projectID ? [row.projectID] : [])),
        ...Object.values(byWorkspace).map((group) => group.projectID),
      ])
      setSessionInventory(
        createSessionInventorySnapshotValue({
          rows,
          groups: byWorkspace,
          workspaceState,
          workspaceOrder,
          projectState: cursor
            ? Object.fromEntries(
                [...projectIDs].map((pid) => [pid, { hasMore: true, loading: false, cursor: undefined }]),
              )
            : {},
          loaded: true,
          ...(cursor ? { initialCursor: Number(cursor) } : {}),
        }),
      )
    } catch {
      updateSessionInventory((draft) => {
        draft.loading = false
      })
    }
  }

  async function reloadWorkspaceGroups(filter?: SessionFilter) {
    try {
      const wsResult = await fetchWorkspaceGrouped({ perGroup: PAGE, filter })
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
            typeof g.nextCursor === "number" ? g.nextCursor : g.hasMore ? wsSessions.at(-1)?.time.updated : undefined,
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
    } catch {}
  }

  async function loadMoreForProject(projectID: string, projectWorktree: string, sandboxes: string[]) {
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
        const sessions = result.data.filter((s) => !!s?.id && !s.parentID)
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
      updateSessionInventory((draft) => {
        if (!draft.projectState[projectID]) return
        draft.projectState[projectID].loading = false
      })
    }
  }

  async function loadMoreForWorkspace(directory: string, filter?: SessionFilter) {
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
      const sessions = result.data.filter((s) => !!s?.id && !s.parentID)
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

  async function reloadProjects() {
    const next = await queryClient.fetchQuery(
      projectListQuery({
        baseUrl: globalSDK.url,
        client: globalSDK.client,
      }),
    )
    setProjects(next)
    return next
  }

  async function ensureProject(directory: string) {
    const dir = directory.trim()
    if (!dir) return
    const workspace = await resolveWorkspaceRuntime({
      baseUrl: globalSDK.url,
      request: platform.fetch,
      directory: dir,
      create: true,
    })
    if (!workspace) throw new Error("Failed to ensure workspace")
    queryClient.invalidateQueries({ queryKey: queryKeys.runtime.workspace({ baseUrl: globalSDK.url, directory: dir }) })
    queryClient.invalidateQueries({ queryKey: queryKeys.controlPlane.projects(globalSDK.url) })
    await reloadProjects()
  }

  const mergeSignedWorkspaceAliases = (next: Project[]) => {
    const merged = [...next] as Array<
      Project & {
        workspaces?: Record<
          string,
          { id?: string; workspaceId?: string; kind?: string; directory?: Project["worktree"] }
        >
      }
    >
    for (const project of projects() as Array<
      Project & {
        workspaces?: Record<
          string,
          { id?: string; workspaceId?: string; kind?: string; directory?: Project["worktree"] }
        >
      }
    >) {
      const aliases = Object.entries(project.workspaces ?? {}).filter(
        ([, workspace]) => workspace.kind === "cloud" || workspace.kind === "user-hosted",
      )
      if (aliases.length === 0) continue
      const existing = merged.find((item) => item.id === project.id)
      if (existing) {
        existing.workspaces = {
          ...Object.fromEntries(aliases),
          ...(existing.workspaces ?? {}),
        }
        existing.sandboxes = [...new Set([...(existing.sandboxes ?? []), ...aliases.map(([key]) => key)])]
        continue
      }
      if (
        merged.some((item) =>
          aliases.some(([key, workspace]) => {
            const found = item.workspaces?.[key]
            return found?.id === workspace.id || found?.workspaceId === workspace.workspaceId
          }),
        )
      )
        continue
      merged.push(project)
    }
    return merged
  }

  const setProjects = (next: Project[] | ((project: Project[]) => Project[] | void)) => {
    const value =
      typeof next === "function"
        ? (() => {
            const draft = projects().slice()
            return next(draft) ?? draft
          })()
        : next
    const merged = mergeSignedWorkspaceAliases(value)
    queryClient.setQueryData(projectQueryKey, merged)
  }

  const applyProjectUpdate = (next: Project[] | ((store: Project[]) => Project[])) => {
    setProjects(next)
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

  function refreshDirectory(
    directory: Parameters<typeof bootstrapInstance>[0],
    harnessType?: string,
    opts?: DirectorySessionCacheRefreshOptions,
  ) {
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
    const workspaceId = workspace?.workspaceId ?? workspaceRuntimeRef(directory)?.workspaceId
    const request = platform.fetch ?? authFetch
    return cachedGlobalSyncSdkClient({
      owner: sdkClientCacheOwner,
      serverUrl: globalSDK.url,
      directory,
      workspaceId,
      create: () =>
        createOpencodeClient({
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
    workspaceRuntimeRef,
    signedWorkspaceInfo,
    signedInventorySource,
    sessionInventory: () => sessionInventory(),
    projectFor,
    inventoryRow,
    cacheSessions,
    sessionCacheLimit,
    sdkFor,
    localSessionListClient: (directory) =>
      createOpencodeClient({
        baseUrl: globalSDK.url,
        fetch: unsignedLocalFetch,
        directory,
        throwOnError: true,
      }),
    setSessionLoadMeta: (directory, value) => queryClient.setQueryData(sessionLoadMetaKey(directory), value),
    markGlobalBootstrapFresh: (baseUrl, harnessType) =>
      queryClient.setQueryData(globalBootstrapFreshKey(baseUrl, harnessType), true),
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

  onCleanup(
    createGlobalSyncEventIngress({
      globalEvents: globalSDK.event,
      claxedoEvents,
      projects,
      projectFor,
      children,
      push: queue.push,
      refresh: queue.refresh,
      setGlobalProject: applyProjectUpdate,
      sessionInventoryLoaded: () => sessionInventory().loaded,
      applySessionEvent: applySessionEventToGlobal,
      draftWasRolledBack: wasRolledBackDraft,
      cacheSessions,
      sessionCacheLimit,
    }),
  )
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of children.directories()) {
      children.disposeDirectory(directory)
    }
    clearGlobalSyncSdkClientsForOwner(sdkClientCacheOwner)
  })

  onSettled(() => {
    queueMicrotask(() => {
      void globalSDK.event.start()
    })
    const loopback = centralTransportForServer(globalSDK.url) === "loopback"
    void (loopback
      ? bootstrapInitialShell({
          baseUrl: globalSDK.url,
          request: globalThis.fetch,
          setGlobalState,
          fallback: bootstrap,
        })
      : bootstrap())
    const cancelMarkdownPrewarm = scheduleMarkdownPrewarm()
    // Local product only — hosted deployments refuse the extension routes.
    // Idle-scheduled like the markdown prewarm, off the boot critical path.
    const cancelUserExtensionLoad = loopback ? scheduleUserExtensionLoad(globalSDK.url) : undefined
    return () => {
      cancelMarkdownPrewarm()
      cancelUserExtensionLoad?.()
    }
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
    inventoryActions: sessionInventoryActions,
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return (
    <Switch>
      <Match when={value.ready}>
        <GlobalSyncContext value={value}>{props.children}</GlobalSyncContext>
      </Match>
    </Switch>
  )
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}

export function useQueryOptions() {
  return useGlobalSync().queryOptions
}
