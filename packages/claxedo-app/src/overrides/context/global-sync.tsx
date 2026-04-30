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
import { queryOptions, skipToken } from "@tanstack/solid-query"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

export const loadSessionsQuery = (directory: string) =>
  queryOptions<null>({ queryKey: [directory, "loadSessions"], queryFn: skipToken })

export const loadMcpQuery = (directory: string, sdk?: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "mcp"],
    queryFn: sdk ? () => sdk.mcp.status().then((r) => r.data ?? {}) : skipToken,
  })

export const loadLspQuery = (directory: string, sdk?: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "lsp"],
    queryFn: sdk ? () => sdk.lsp.status().then((r) => r.data ?? []) : skipToken,
  })
import { createChildStoreManager } from "@/context/global-sync/child-store"
import { trimSessions } from "@/context/global-sync/session-trim"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "@/context/global-sync/session-load"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "@/context/global-sync/event-reducer"
import { bootstrapDirectory, bootstrapGlobal } from "@/context/global-sync/bootstrap"
import { clearSessionPrefetchDirectory } from "@/context/global-sync/session-prefetch"
import { sanitizeProject } from "@/context/global-sync/utils"
import type { ProjectMeta, GlobalSessionItem, GlobalSessionState, WorkspaceGroup } from "@/context/global-sync/types"
import { SESSION_RECENT_LIMIT } from "@/context/global-sync/types"
import type { Session, GlobalSession } from "@opencode-ai/sdk/v2/client"
import { applySessionFilter, type SessionFilter } from "@/context/global-sync/session-filter"
import { queryClient } from "../../shared/query/query-client"
import { queryKeys } from "../../shared/query/keys"
import { projectListQuery } from "../../shared/query/shell"
import { resolveWorkspaceRuntime } from "../../cloud/runtime/workspace-runtime-store"
import { authFetch, getClaxedoServerUrl } from "../../utils/api"

const GLOBAL_TAG = "global"
const GLOBAL_SHOW_TAG = "global:default"
const PAGE = 5

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

  const sdkCache = new Map<string, ReturnType<typeof createOpencodeClient>>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  // Global sessions store — one fetch for all projects
  const [globalSessionStore, setGlobalSessionStore] = createStore<GlobalSessionState>({
    global: [],
    globalState: { hasMore: false, loading: false, cursor: undefined },
    byProject: {},
    projectState: {},
    byWorkspace: {},
    workspaceState: {},
    workspaceOrder: [],
    loading: false,
    loaded: false,
  })

  function projectFor(directory: string) {
    return globalStore.project.find((item) => item.worktree === directory || item.sandboxes?.includes(directory))
  }

  function rec(input: unknown) {
    return input && typeof input === "object" ? input as Record<string, unknown> : undefined
  }

  function txt(input: unknown) {
    return typeof input === "string" ? input : undefined
  }

  function attachments(input: unknown) {
    if (!Array.isArray(input)) return []
    return input.flatMap((item) => {
      const row = rec(item)
      const kind = txt(row?.kind)
      const targetID = txt(row?.targetID) ?? txt(row?.target_id)
      if (!kind || !targetID) return []
      return [{ kind, targetID }]
    })
  }

  function environment(input: unknown) {
    const row = rec(input)
    if (!row) return
    const kind = txt(row.kind)
    const provider = txt(row.provider)
    if (!kind && !provider) return
    return {
      ...(kind ? { kind } : {}),
      ...(provider ? { provider } : {}),
    }
  }

  function git(input: unknown) {
    const row = rec(input)
    if (!row) return
    const repo = txt(row.repo)
    const branch = txt(row.branch)
    const remote = txt(row.remote)
    if (!repo && !branch && !remote) return
    return {
      ...(repo ? { repo } : {}),
      ...(branch ? { branch } : {}),
      ...(remote ? { remote } : {}),
    }
  }

  function toGlobalSessionItem(s: GlobalSession): GlobalSessionItem {
    const row = s as GlobalSession & {
      rootID?: string
      tags?: string[]
      attachments?: unknown[]
      environment?: unknown
      git?: unknown
    }
    const projectID = s.projectID || projectFor(s.directory)?.id || s.directory
    const env = environment(row.environment)
    const vcs = git(row.git)
    return {
      id: s.id,
      title: s.title || "New Session",
      directory: s.directory,
      projectID,
      ...(s.parentID ? { parentID: s.parentID } : {}),
      ...(row.rootID ? { rootID: row.rootID } : {}),
      tags: Array.isArray(row.tags) ? row.tags.filter((item): item is string => typeof item === "string") : [],
      attachments: attachments(row.attachments),
      ...(env ? { environment: env } : {}),
      ...(vcs ? { git: vcs } : {}),
      ...(typeof s.time.archived === "number" ? { archived: true } : {}),
      time: { created: s.time.created, updated: s.time.updated },
    }
  }

  function isGlobal(item: Pick<GlobalSessionItem, "tags">) {
    return item.tags.includes(GLOBAL_TAG)
  }

  function showGlobal(item: Pick<GlobalSessionItem, "tags">) {
    return item.tags.includes(GLOBAL_SHOW_TAG)
  }

  function insertSorted(arr: GlobalSessionItem[], item: GlobalSessionItem): GlobalSessionItem[] {
    const next = arr.filter((x) => x.id !== item.id)
    const idx = next.findIndex((x) => (x.time.updated ?? 0) < (item.time.updated ?? 0))
    if (idx === -1) next.push(item)
    else next.splice(idx, 0, item)
    return next
  }

  async function fetchGlobalList(opts: { directory?: string; limit: number; cursor?: number }) {
    const url = new URL("/experimental/session", globalSDK.url)
    url.searchParams.set("roots", "true")
    url.searchParams.set("archived", "all")
    url.searchParams.set("limit", String(opts.limit))
    if (opts.directory) url.searchParams.set("directory", opts.directory)
    if (typeof opts.cursor === "number") url.searchParams.set("cursor", String(opts.cursor))
    const res = await (platform.fetch ?? globalThis.fetch)(url, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return { data: [] as any[], cursor: null as string | null }
    const body = await res.json().catch(() => [])
    return {
      data: Array.isArray(body) ? body : [],
      cursor: res.headers.get("x-next-cursor"),
    }
  }

  async function loadGlobalSessions() {
    if (globalSessionStore.loaded || globalSessionStore.loading) return
    setGlobalSessionStore("loading", true)
    try {
      const [flatResult, wsResult] = await Promise.all([
        fetchGlobalList({ limit: 100 }),
        fetchWorkspaceGrouped({ perGroup: PAGE }),
      ])
      const sessions = flatResult.data.filter((s) => !!s?.id && !s.parentID)
      const cursor = flatResult.cursor

      // Group by projectID
      const grouped: Record<string, GlobalSessionItem[]> = {}
      const globals: GlobalSessionItem[] = []
      for (const s of sessions) {
        const item = toGlobalSessionItem(s)
        if (isGlobal(item)) {
          if (showGlobal(item)) globals.push(item)
          continue
        }
        if (!grouped[item.projectID]) grouped[item.projectID] = []
        grouped[item.projectID].push(item)
      }
      // Sort each group by time.updated desc
      for (const pid of Object.keys(grouped)) {
        grouped[pid].sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
      }

      // Build workspace-level stores
      const byWorkspace: Record<string, WorkspaceGroup> = {}
      const workspaceState: Record<string, { hasMore: boolean; loading: boolean; cursor?: number }> = {}
      const workspaceOrder: string[] = []
      for (const g of wsResult) {
        const wsSessions = (g.sessions ?? [])
          .filter((s: any) => !!s?.id)
          .map((s: any) => toGlobalSessionItem(s))
          .sort((a: GlobalSessionItem, b: GlobalSessionItem) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
        byWorkspace[g.directory] = {
          directory: g.directory,
          projectID: g.projectID,
          sessions: wsSessions,
          hasMore: g.hasMore,
          total: g.total,
          nextCursor: typeof g.nextCursor === "number" ? g.nextCursor : undefined,
        }
        workspaceState[g.directory] = {
          hasMore: g.hasMore,
          loading: false,
          cursor:
            typeof g.nextCursor === "number"
              ? g.nextCursor
              : g.hasMore
                ? wsSessions.at(-1)?.time.updated
                : undefined,
        }
        workspaceOrder.push(g.directory)
      }

      setGlobalSessionStore(
        produce((draft) => {
          draft.byProject = grouped
          draft.global = globals.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
          draft.globalState = { hasMore: false, loading: false, cursor: undefined }
          draft.byWorkspace = byWorkspace
          draft.workspaceState = workspaceState
          draft.workspaceOrder = workspaceOrder
          draft.loading = false
          draft.loaded = true
          if (cursor) draft.initialCursor = Number(cursor)
          // Mark hasMore for projects when cursor exists
          if (cursor) {
            for (const pid of Object.keys(grouped)) {
              if (!draft.projectState[pid]) draft.projectState[pid] = { hasMore: false, loading: false, cursor: undefined }
              draft.projectState[pid].hasMore = true
            }
          }
        }),
      )
    } catch {
      setGlobalSessionStore("loading", false)
    }
  }

  async function fetchWorkspaceGrouped(opts: { perGroup?: number; filter?: SessionFilter } = {}): Promise<any[]> {
    const url = new URL("/experimental/session", getClaxedoServerUrl())
    url.searchParams.set("roots", "true")
    url.searchParams.set("groupBy", "workspace")
    url.searchParams.set("perGroup", String(opts.perGroup ?? PAGE))
    applySessionFilter(url, opts.filter)
    const res = await authFetch(url, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return []
    const body = await res.json().catch(() => ({ groups: [] }))
    return body?.groups ?? []
  }

  async function fetchWorkspacePage(directory: string, opts: { limit: number; filter?: SessionFilter; cursor?: number }) {
    const url = new URL("/experimental/session", getClaxedoServerUrl())
    url.searchParams.set("roots", "true")
    url.searchParams.set("directory", directory)
    url.searchParams.set("limit", String(opts.limit))
    if (typeof opts.cursor === "number") url.searchParams.set("cursor", String(opts.cursor))
    applySessionFilter(url, opts.filter)
    const res = await authFetch(url, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return { data: [] as any[], cursor: null as string | null }
    const body = await res.json().catch(() => [])
    return {
      data: Array.isArray(body) ? body : [],
      cursor: res.headers.get("x-next-cursor"),
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
          .filter((s: any) => !!s?.id)
          .map((s: any) => toGlobalSessionItem(s))
          .sort((a: GlobalSessionItem, b: GlobalSessionItem) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
        byWorkspace[g.directory] = {
          directory: g.directory,
          projectID: g.projectID,
          sessions: wsSessions,
          hasMore: g.hasMore,
          total: g.total,
          nextCursor: typeof g.nextCursor === "number" ? g.nextCursor : undefined,
        }
        workspaceState[g.directory] = {
          hasMore: g.hasMore,
          loading: false,
          cursor:
            typeof g.nextCursor === "number"
              ? g.nextCursor
              : g.hasMore
                ? wsSessions.at(-1)?.time.updated
                : undefined,
        }
        workspaceOrder.push(g.directory)
      }
      setGlobalSessionStore(
        produce((draft) => {
          draft.byWorkspace = byWorkspace
          draft.workspaceState = workspaceState
          draft.workspaceOrder = workspaceOrder
        }),
      )
    } catch {
    }
  }

  async function loadMoreForProject(projectID: string, projectWorktree: string, sandboxes: string[]) {
    const pState = globalSessionStore.projectState[projectID]
    if (pState?.loading) return

    setGlobalSessionStore("projectState", projectID, {
      hasMore: pState?.hasMore ?? true,
      loading: true,
      cursor: pState?.cursor,
    })

    try {
      const directories = [projectWorktree, ...sandboxes.filter((s) => s !== projectWorktree)]
      const allNew: GlobalSessionItem[] = []

      for (const dir of directories) {
        const result = await fetchGlobalList({ directory: dir, limit: PAGE })
        const sessions = result.data.filter((s) => !!s?.id && !s.parentID)
        for (const s of sessions) {
          allNew.push(toGlobalSessionItem(s))
        }
        const cursor = result.cursor

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
            if (!draft.projectState[projectID]) {
              draft.projectState[projectID] = { hasMore: false, loading: false, cursor: undefined }
            }
            draft.projectState[projectID].hasMore = !!cursor
          }),
        )
      }
    } catch {
    } finally {
      setGlobalSessionStore("projectState", projectID, "loading", false)
    }
  }

  async function loadMoreForWorkspace(directory: string, filter?: SessionFilter) {
    const wState = globalSessionStore.workspaceState[directory]
    if (wState?.loading) return

    setGlobalSessionStore("workspaceState", directory, {
      hasMore: wState?.hasMore ?? true,
      loading: true,
      cursor: wState?.cursor,
    })

    try {
      const result = await fetchWorkspacePage(directory, { limit: PAGE, filter, cursor: wState?.cursor })
      const sessions = result.data.filter((s) => !!s?.id && !s.parentID)
      const cursor = result.cursor

      setGlobalSessionStore(
        produce((draft) => {
          const ws = draft.byWorkspace[directory]
          if (!ws) return
          const existingIds = new Set(ws.sessions.map((x) => x.id))
          const merged = [...ws.sessions]
          for (const s of sessions) {
            const item = toGlobalSessionItem(s)
            if (!existingIds.has(item.id)) {
              merged.push(item)
            }
          }
          merged.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
          ws.sessions = merged
          ws.total = Math.max(ws.total, merged.length)
          const more = !!cursor || merged.length < ws.total
          const next = cursor
            ? Number(cursor)
            : more
              ? (merged.at(-1)?.time.updated ?? merged.at(-1)?.time.created)
              : undefined
          ws.hasMore = more
          ws.nextCursor = next
          if (!draft.workspaceState[directory]) {
            draft.workspaceState[directory] = { hasMore: false, loading: false, cursor: undefined }
          }
          draft.workspaceState[directory].hasMore = more
          draft.workspaceState[directory].cursor = next
        }),
      )
    } catch {
    } finally {
      setGlobalSessionStore("workspaceState", directory, "loading", false)
    }
  }

  function applySessionEventToGlobal(info: Session, type: "created" | "updated" | "deleted") {
    const tags = Array.isArray((info as Session & { tags?: string[] }).tags)
      ? ((info as Session & { tags?: string[] }).tags?.filter((item): item is string => typeof item === "string") ?? [])
      : []
    const isTaggedGlobal = tags.includes(GLOBAL_TAG)
    const showTaggedGlobal = tags.includes(GLOBAL_SHOW_TAG)
    const projectID = info.projectID
    if (!projectID && !isTaggedGlobal) return
    if (info.parentID) return // Only track root sessions

    setGlobalSessionStore(
      produce((draft) => {
        if (type === "deleted" && isTaggedGlobal) {
          draft.global = draft.global.filter((x) => x.id !== info.id)
          return
        }

        if (isTaggedGlobal) {
          if (!showTaggedGlobal) {
            draft.global = draft.global.filter((x) => x.id !== info.id)
            return
          }
          const item: GlobalSessionItem = {
            id: info.id,
            title: info.title || "New Session",
            directory: info.directory,
            projectID: "global",
            tags,
            attachments: [],
            ...(typeof info.time.archived === "number" ? { archived: true } : {}),
            time: { created: info.time.created, updated: info.time.updated },
          }
          draft.global = insertSorted(draft.global, item)
          return
        }

        const existing = draft.byProject[projectID!] ?? []

        if (type === "deleted") {
          draft.byProject[projectID!] = existing.filter((x) => x.id !== info.id)
          // Also remove from workspace group
          const ws = draft.byWorkspace[info.directory]
          if (ws) {
            ws.sessions = ws.sessions.filter((x) => x.id !== info.id)
            ws.total = ws.sessions.length
          }
          return
        }

        const item: GlobalSessionItem = {
          id: info.id,
          title: info.title || "New Session",
          directory: info.directory,
          projectID,
          tags: [],
          attachments: [],
          ...(typeof info.time.archived === "number" ? { archived: true } : {}),
          time: { created: info.time.created, updated: info.time.updated },
        }
        draft.byProject[projectID!] = insertSorted(existing, item)

        // Also update workspace group
        const ws = draft.byWorkspace[info.directory]
        if (ws) {
          ws.sessions = insertSorted(ws.sessions, item)
          ws.total = ws.sessions.length
        } else {
          // New workspace — add it
          draft.byWorkspace[info.directory] = {
            directory: info.directory,
            projectID,
            sessions: [item],
            hasMore: false,
            total: 1,
            nextCursor: undefined,
          }
          if (!draft.workspaceState[info.directory]) {
            draft.workspaceState[info.directory] = { hasMore: false, loading: false, cursor: undefined }
          }
          if (!draft.workspaceOrder.includes(info.directory)) {
            draft.workspaceOrder.unshift(info.directory)
          }
        }
      }),
    )
  }

  function dropGlobalSession(input: { id: string; directory: string; projectID?: string; tags?: string[] }) {
    setGlobalSessionStore(
      produce((draft) => {
        const tags = input.tags ?? []
        if (tags.includes(GLOBAL_TAG)) {
          draft.global = draft.global.filter((item) => item.id !== input.id)
        }
        if (input.projectID) {
          draft.byProject[input.projectID] = (draft.byProject[input.projectID] ?? []).filter((item) => item.id !== input.id)
        } else {
          for (const key of Object.keys(draft.byProject)) {
            draft.byProject[key] = draft.byProject[key].filter((item) => item.id !== input.id)
          }
        }
        const ws = draft.byWorkspace[input.directory]
        if (ws) {
          ws.sessions = ws.sessions.filter((item) => item.id !== input.id)
          ws.total = ws.sessions.length
        }
      }),
    )
  }

  async function reloadProjects() {
    const next = await queryClient.fetchQuery(projectListQuery({
      baseUrl: globalSDK.url,
      client: globalSDK.client,
    }))
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
    queryClient.invalidateQueries({ queryKey: queryKeys.shell.projects(globalSDK.url) })
    await reloadProjects()
  }

  const [projectCache, setProjectCache, projectInit] = persisted(
    Persist.global("globalSync.project", ["globalSync.project.v1"]),
    createStore({ value: [] as Project[] }),
  )
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

  let projectWritten = false

  const cacheProjects = () => {
    setProjectCache(
      "value",
      untrack(() => globalStore.project.map(sanitizeProject)),
    )
  }

  const setProjects = (next: Project[] | ((draft: Project[]) => void)) => {
    projectWritten = true
    if (typeof next === "function") {
      setGlobalStore("project", produce(next))
      cacheProjects()
      return
    }
    setGlobalStore("project", next)
    cacheProjects()
  }

  const applyProjectUpdate = (next: Project[] | ((store: Project[]) => Project[])) => {
    projectWritten = true
    if (typeof next === "function") {
      setGlobalStore("project", next)
      cacheProjects()
      return
    }
    setGlobalStore("project", next)
    cacheProjects()
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => void))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  if (projectInit instanceof Promise) {
    void projectInit.then(() => {
      if (projectWritten) return
      const cached = projectCache.value
      if (cached.length === 0) return
      setGlobalStore("project", cached)
    })
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    bootstrap,
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      queue.clear(directory)
      sessionMeta.delete(directory)
      sdkCache.delete(directory)
      clearSessionPrefetchDirectory(directory)
    },
    translate: language.t,
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

  const setSessionTodo = (sessionID: string, todos: Todo[] | undefined) => {
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
  }

  async function loadSessions(directory: string) {
    const pending = sessionLoads.get(directory)
    if (pending) return pending

    children.pin(directory)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(directory)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, {
        limit: store.limit,
        permission: store.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
        cleanupDroppedSessionCaches(store, setStore, next, setSessionTodo, directory)
      }
      children.unpin(directory)
      return
    }

    const limit = Math.max(store.limit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = loadRootSessionsWithFallback({
      directory,
      limit,
      list: (query) => globalSDK.client.session.list(query),
    })
      .then((x) => {
        const nonArchived = (x.data ?? [])
          .filter((s) => !!s?.id)
          .filter((s) => !s.time?.archived)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const limit = store.limit
        const childSessions = store.session.filter((s) => !!s.parentID)
        const sessions = trimSessions([...nonArchived, ...childSessions], {
          limit,
          permission: store.permission,
        })
        setStore(
          "sessionTotal",
          estimateRootSessionTotal({ count: nonArchived.length, limit: x.limit, limited: x.limited }),
        )
        setStore("session", reconcile(sessions, { key: "id" }))
        cleanupDroppedSessionCaches(store, setStore, sessions, setSessionTodo, directory)
        sessionMeta.set(directory, { limit })
      })
      .catch((err) => {
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

  async function bootstrapInstance(directory: string, runnerType?: string) {
    if (!directory) return
    const pending = booting.get(directory)
    if (pending) return pending

    children.pin(directory)
    const promise = (async () => {
      const child = children.ensureChild(directory)
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        sdk,
        store: child[0],
        setStore: child[1],
        loadSessions,
        translate: language.t,
        fetch: platform.fetch,
        baseUrl: globalSDK.url,
        runnerType,
      })
    })()

    booting.set(directory, promise)
    promise.finally(() => {
      booting.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  function refreshDirectory(directory: string, runnerType?: string) {
    if (!directory) return Promise.resolve()
    return bootstrapInstance(directory, runnerType)
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: queue.refresh,
        setGlobalProject: applyProjectUpdate,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      return
    }

    const existing = children.children[directory]
    if (!existing) {
      return
    }
    children.mark(directory)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      setSessionTodo,
      vcsCache: children.vcsCache.get(directory),
      loadLsp: () => {},
    })

    // Sync session events to global sessions store
    if (globalSessionStore.loaded) {
      const sessionEventType = event.type === "session.created" ? "created"
        : event.type === "session.updated" ? "updated"
        : event.type === "session.deleted" ? "deleted"
        : null
      if (sessionEventType) {
        const info = (event.properties as { info: Session }).info
        if (!info.projectID && info.directory) {
          const project = projectFor(info.directory)
          if (project?.id) info.projectID = project.id
        }
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

  async function bootstrap(runnerType?: string) {
    await bootstrapGlobal({
      baseUrl: globalSDK.url,
      globalSDK: globalSDK.client,
      fetch: platform.fetch ?? globalThis.fetch,
      connectErrorTitle: language.t("dialog.server.add.error"),
      connectErrorDescription: language.t("error.globalSync.connectFailed", { url: globalSDK.url }),
      requestFailedTitle: language.t("common.requestFailed"),
      translate: language.t,
      formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
      setGlobalStore: setBootStore,
      runnerType,
    })
  }

  onMount(() => {
    queueMicrotask(() => {
      void globalSDK.event.start()
    })
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
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    bootstrap,
    refreshDirectory,
    updateConfig: async (config: Config) => {
      setGlobalStore("reload", "pending")
      return globalSDK.client.global.config
        .update({ config })
        .then(() => bootstrap())
        .then(() => {
          queue.refresh()
          setGlobalStore("reload", undefined)
          queue.refresh()
        })
        .catch((error) => {
          setGlobalStore("reload", undefined)
          throw error
        })
    },
    project: {
      ensure: ensureProject,
      reload: reloadProjects,
      loadSessions,
      meta: projectMeta,
      icon: projectIcon,
    },
    globalSessions: {
      store: globalSessionStore,
      load: loadGlobalSessions,
      reloadWorkspace: reloadWorkspaceGroups,
      loadMore: loadMoreForProject,
      loadMoreWorkspace: loadMoreForWorkspace,
      drop: dropGlobalSession,
    },
    todo: {
      set: setSessionTodo,
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
