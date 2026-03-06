import {
  type Config,
  type Path,
  type Project,
  type ProviderAuthResponse,
  type ProviderListResponse,
  type Todo,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import { createStore, produce, reconcile } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import type { InitError } from "@/pages/error"
import {
  createContext,
  createEffect,
  createSignal,
  untrack,
  getOwner,
  useContext,
  onCleanup,
  onMount,
  type ParentProps,
  Switch,
  Match,
} from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"
import { formatServerError } from "@/utils/server-errors"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { createRefreshQueue } from "@/context/global-sync/queue"
import { createChildStoreManager } from "@/context/global-sync/child-store"
import { trimSessions } from "@/context/global-sync/session-trim"
import { estimateRootSessionTotal, loadRootSessionsWithFallback, shouldUseSessionCache } from "@/context/global-sync/session-load"
import { applyDirectoryEvent, applyGlobalEvent } from "@/context/global-sync/event-reducer"
import { bootstrapDirectory, bootstrapGlobal } from "@/context/global-sync/bootstrap"
import { sanitizeProject } from "@/context/global-sync/utils"
import type { ProjectMeta, GlobalSessionItem, GlobalSessionState } from "@/context/global-sync/types"
import { SESSION_RECENT_LIMIT } from "@/context/global-sync/types"
import type { Session, GlobalSession } from "@opencode-ai/sdk/v2/client"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
  session_todo: { [sessionID: string]: Todo[] }
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

  const stats = {
    evictions: 0,
    loadSessionsFallback: 0,
  }

  const sdkCache = new Map<string, ReturnType<typeof createOpencodeClient>>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  // Global sessions store — one fetch for all projects
  const [globalSessionStore, setGlobalSessionStore] = createStore<GlobalSessionState>({
    byProject: {},
    projectState: {},
    loading: false,
    loaded: false,
  })

  function toGlobalSessionItem(s: GlobalSession): GlobalSessionItem {
    return {
      id: s.id,
      title: s.title || "New Session",
      directory: s.directory,
      projectID: s.projectID,
      time: { created: s.time.created, updated: s.time.updated },
    }
  }

  function insertSorted(arr: GlobalSessionItem[], item: GlobalSessionItem): GlobalSessionItem[] {
    const next = arr.filter((x) => x.id !== item.id)
    const idx = next.findIndex((x) => (x.time.updated ?? 0) < (item.time.updated ?? 0))
    if (idx === -1) next.push(item)
    else next.splice(idx, 0, item)
    return next
  }

  async function loadGlobalSessions() {
    if (globalSessionStore.loaded || globalSessionStore.loading) return
    setGlobalSessionStore("loading", true)
    try {
      const result = await globalSDK.client.experimental.session.list({
        roots: true,
        limit: 100,
      })
      const sessions = (result.data ?? []).filter((s) => !!s?.id && !s.parentID && !s.time?.archived)
      const cursor = result.response?.headers?.get("x-next-cursor")

      // Group by projectID
      const grouped: Record<string, GlobalSessionItem[]> = {}
      for (const s of sessions) {
        const item = toGlobalSessionItem(s)
        if (!grouped[item.projectID]) grouped[item.projectID] = []
        grouped[item.projectID].push(item)
      }
      // Sort each group by time.updated desc
      for (const pid of Object.keys(grouped)) {
        grouped[pid].sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
      }

      setGlobalSessionStore(
        produce((draft) => {
          draft.byProject = grouped
          draft.loading = false
          draft.loaded = true
          if (cursor) draft.initialCursor = Number(cursor)
          // Mark hasMore for projects when cursor exists
          if (cursor) {
            for (const pid of Object.keys(grouped)) {
              if (!draft.projectState[pid]) draft.projectState[pid] = { hasMore: false, loading: false }
              draft.projectState[pid].hasMore = true
            }
          }
        }),
      )
    } catch (err) {
      console.error("Failed to load global sessions", err)
      setGlobalSessionStore("loading", false)
    }
  }

  async function loadMoreForProject(projectWorktree: string, sandboxes: string[]) {
    // Find projectID from the child store
    const [childStore] = children.child(projectWorktree, { bootstrap: false })
    const projectID = childStore.project
    if (!projectID) return

    const pState = globalSessionStore.projectState[projectID]
    if (pState?.loading) return

    setGlobalSessionStore("projectState", projectID, { hasMore: pState?.hasMore ?? true, loading: true })

    try {
      const directories = [projectWorktree, ...sandboxes.filter((s) => s !== projectWorktree)]
      const allNew: GlobalSessionItem[] = []

      for (const dir of directories) {
        const result = await globalSDK.client.experimental.session.list({
          directory: dir,
          roots: true,
          limit: 20,
        })
        const sessions = (result.data ?? []).filter((s) => !!s?.id && !s.parentID && !s.time?.archived)
        for (const s of sessions) {
          allNew.push(toGlobalSessionItem(s))
        }
        const cursor = result.response?.headers?.get("x-next-cursor")

        setGlobalSessionStore(
          produce((draft) => {
            const existing = draft.byProject[projectID] ?? []
            const existingIds = new Set(existing.map((x) => x.id))
            const merged = [...existing]
            for (const item of allNew.filter((x) => x.directory === dir && !existingIds.has(x.id))) {
              merged.push(item)
            }
            merged.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
            draft.byProject[projectID] = merged
            if (!draft.projectState[projectID]) draft.projectState[projectID] = { hasMore: false, loading: false }
            draft.projectState[projectID].hasMore = !!cursor
          }),
        )
      }
    } catch (err) {
      console.error("Failed to load more sessions for project", err)
    } finally {
      setGlobalSessionStore("projectState", projectID, "loading", false)
    }
  }

  function applySessionEventToGlobal(info: Session, type: "created" | "updated" | "deleted") {
    const projectID = info.projectID
    if (!projectID) return
    if (info.parentID) return // Only track root sessions

    setGlobalSessionStore(
      produce((draft) => {
        const existing = draft.byProject[projectID] ?? []

        if (type === "deleted" || (type === "updated" && info.time?.archived)) {
          draft.byProject[projectID] = existing.filter((x) => x.id !== info.id)
          return
        }

        const item: GlobalSessionItem = {
          id: info.id,
          title: info.title || "New Session",
          directory: info.directory,
          projectID,
          time: { created: info.time.created, updated: info.time.updated },
        }
        draft.byProject[projectID] = insertSorted(existing, item)
      }),
    )
  }

  const [projectCache, setProjectCache, projectInit] = persisted(
    Persist.global("globalSync.project", ["globalSync.project.v1"]),
    createStore({ value: [] as Project[] }),
  )
  const [projectCacheReady, setProjectCacheReady] = createSignal(!(projectInit instanceof Promise))
  if (projectInit instanceof Promise) {
    void projectInit.then(() => setProjectCacheReady(true))
  }

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    project: projectCache.value,
    provider: { all: [], connected: [], default: {} },
    provider_auth: {},
    config: {},
    reload: undefined,
    session_todo: {},
  })

  const updateStats = (activeDirectoryStores: number) => {
    if (!import.meta.env.DEV) return
    ;(
      globalThis as {
        __OPENCODE_GLOBAL_SYNC_STATS?: {
          activeDirectoryStores: number
          evictions: number
          loadSessionsFullFetchFallback: number
        }
      }
    ).__OPENCODE_GLOBAL_SYNC_STATS = {
      activeDirectoryStores,
      evictions: stats.evictions,
      loadSessionsFullFetchFallback: stats.loadSessionsFallback,
    }
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    bootstrap,
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    markStats: updateStats,
    incrementEvictions: () => {
      stats.evictions += 1
      updateStats(Object.keys(children.children).length)
    },
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      queue.clear(directory)
      sessionMeta.delete(directory)
      sdkCache.delete(directory)
    },
  })

  const sdkFor = (directory: string) => {
    const cached = sdkCache.get(directory)
    if (cached) return cached
    const sdk = createOpencodeClient({
      baseUrl: globalSDK.url,
      fetch: platform.fetch,
      directory,
      throwOnError: true,
    })
    sdkCache.set(directory, sdk)
    return sdk
  }

  createEffect(() => {
    if (!projectCacheReady()) return
    if (globalStore.project.length !== 0) return
    const cached = projectCache.value
    if (cached.length === 0) return
    setGlobalStore("project", cached)
  })

  createEffect(() => {
    if (!projectCacheReady()) return
    const projects = globalStore.project
    if (projects.length === 0) {
      const cachedLength = untrack(() => projectCache.value.length)
      if (cachedLength !== 0) return
    }
    setProjectCache("value", projects.map(sanitizeProject))
  })

  createEffect(() => {
    if (globalStore.reload !== "complete") return
    setGlobalStore("reload", undefined)
    queue.refresh()
  })

  async function loadSessions(directory: string) {
    const pending = sessionLoads.get(directory)
    if (pending) return pending

    children.pin(directory)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const cache = children.sessionCache.get(directory)
    const cached = cache?.store.value
    const fresh =
      cache?.ready() &&
      cached &&
      shouldUseSessionCache({
        at: cached.at,
        now: Date.now(),
        cachedLimit: cached.limit,
        requestedLimit: store.limit,
        sessionCount: cached.session.length,
      })
    if (fresh && cached) {
      const next = trimSessions(cached.session, { limit: store.limit, permission: store.permission })
      setStore("sessionTotal", cached.total)
      setStore("session", reconcile(next, { key: "id" }))
      sessionMeta.set(directory, { limit: cached.limit })
      children.unpin(directory)
      return
    }
    const meta = sessionMeta.get(directory)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, { limit: store.limit, permission: store.permission })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(directory)
      return
    }

    const limit = Math.max(store.limit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = loadRootSessionsWithFallback({
      directory,
      limit,
      list: (query) => globalSDK.client.session.list(query),
      onFallback: () => {
        stats.loadSessionsFallback += 1
        updateStats(Object.keys(children.children).length)
      },
    })
      .then((x) => {
        const nonArchived = (x.data ?? [])
          .filter((s) => !!s?.id)
          .filter((s) => !s.time?.archived)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const limit = store.limit
        const childSessions = store.session.filter((s) => !!s.parentID)
        const sessions = trimSessions([...nonArchived, ...childSessions], { limit, permission: store.permission })
        setStore(
          "sessionTotal",
          estimateRootSessionTotal({ count: nonArchived.length, limit: x.limit, limited: x.limited }),
        )
        setStore("session", reconcile(sessions, { key: "id" }))
        cache?.setStore("value", {
          at: Date.now(),
          limit,
          total: estimateRootSessionTotal({ count: nonArchived.length, limit: x.limit, limited: x.limited }),
          session: nonArchived,
        })
        sessionMeta.set(directory, { limit })
      })
      .catch((err) => {
        console.error("Failed to load sessions", err)
        const project = getFilename(directory)
        showToast({ variant: "error", title: language.t("toast.session.listFailed.title", { project }), description: formatServerError(err, language.t) })
      })

    sessionLoads.set(directory, promise)
    promise.finally(() => {
      sessionLoads.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    if (!directory) return
    const pending = booting.get(directory)
    if (pending) return pending

    children.pin(directory)
    const promise = (async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(directory)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
      })
    })()

    booting.set(directory, promise)
    promise.finally(() => {
      booting.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: queue.refresh,
        setGlobalProject(next) {
          if (typeof next === "function") {
            setGlobalStore("project", produce(next))
            return
          }
          setGlobalStore("project", next)
        },
      })
      return
    }

    const existing = children.children[directory]
    if (!existing) return
    children.mark(directory)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      vcsCache: children.vcsCache.get(directory),
      loadLsp: () => {
        sdkFor(directory)
          .lsp.status()
          .then((x) => setStore("lsp", x.data ?? []))
      },
    })

    // Sync session events to global sessions store
    if (globalSessionStore.loaded) {
      const sessionEventType = event.type === "session.created" ? "created"
        : event.type === "session.updated" ? "updated"
        : event.type === "session.deleted" ? "deleted"
        : null
      if (sessionEventType) {
        const info = (event.properties as { info: Session }).info
        applySessionEventToGlobal(info, sessionEventType)
      }
    }
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directory)
    }
  })

  async function bootstrap() {
    await bootstrapGlobal({
      globalSDK: globalSDK.client,
      connectErrorTitle: language.t("dialog.server.add.error"),
      connectErrorDescription: language.t("error.globalSync.connectFailed", { url: globalSDK.url }),
      requestFailedTitle: language.t("common.requestFailed"),
      translate: language.t,
      formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
      setGlobalStore,
    })
  }

  onMount(() => {
    void bootstrap()
  })

  function projectMeta(directory: string, patch: ProjectMeta) {
    children.projectMeta(directory, patch)
  }

  function projectIcon(directory: string, value: string | undefined) {
    children.projectIcon(directory, value)
  }

  return {
    data: globalStore,
    set: setGlobalStore,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    bootstrap,
    updateConfig: (config: Config) => {
      setGlobalStore("reload", "pending")
      return globalSDK.client.global.config.update({ config }).finally(() => {
        setTimeout(() => {
          setGlobalStore("reload", "complete")
        }, 1000)
      })
    },
    project: {
      loadSessions,
      meta: projectMeta,
      icon: projectIcon,
    },
    globalSessions: {
      store: globalSessionStore,
      load: loadGlobalSessions,
      loadMore: loadMoreForProject,
    },
    todo: {
      set: (sessionID: string, todos: Todo[] | undefined) => {
        if (!sessionID) return
        if (!todos) {
          setGlobalStore(
            "session_todo",
            produce((draft) => {
              delete draft[sessionID]
            }),
          )
          return
        }
        setGlobalStore("session_todo", sessionID, reconcile(todos, { key: "id" }))
      },
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return (
    <Switch>
      <Match when={value.ready}>
        <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
      </Match>
    </Switch>
  )
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}

export { canDisposeDirectory, pickDirectoriesToEvict } from "@/context/global-sync/eviction"
export { estimateRootSessionTotal, loadRootSessionsWithFallback, shouldUseSessionCache } from "@/context/global-sync/session-load"
