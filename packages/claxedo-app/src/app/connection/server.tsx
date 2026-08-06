import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useQuery } from "@tanstack/solid-query"
import { type Accessor, batch, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { Persist, persisted } from "@/platform/persistence/persist"
import { validWorktree } from "@/platform/sync/worktree"
import { getExtensions } from "@/features/extensions"
import { isDemoMode } from "@/platform/api/api"
import { DEFAULT_LOCAL_CLAXEDO_SERVER_PORT } from "@/platform/api/local-server"
import { queryClient } from "@/platform/query/query-client"
import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"
import { ServerConnection } from "@/platform/connection/server-connection"

export { ServerConnection } from "@/platform/connection/server-connection"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
type WorkspaceServerMap = Record<string, string>

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withProtocol)
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    // In demo mode, keep the origin as-is so MSW can intercept all requests
    if (local && (url.port === "3000" || url.port === "4444") && !isDemoMode()) {
      const env = import.meta.env.VITE_OPENCODE_BACKEND_URL as string | undefined
      if (env?.trim()) return env.trim().replace(/\/+$/, "")
      url.port = String(DEFAULT_LOCAL_CLAXEDO_SERVER_PORT)
      return url.toString().replace(/\/+$/, "")
    }
  } catch {
    return withProtocol.replace(/\/+$/, "")
  }
  return withProtocol.replace(/\/+$/, "")
}

function serverDisplayName(conn?: ServerConnection.Any | string) {
  if (!conn) return ""
  const url = typeof conn === "string" ? conn : conn.http.url
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

const healthFetchIds = new WeakMap<typeof globalThis.fetch, number>()
let nextHealthFetchId = 0
const HEALTH_CACHE_MS = 10_000
const opencodeServerHealthQueryRoot = ["shell", "opencode-server-health"] as const
const opencodeServerHealthPollQueryRoot = ["shell", "opencode-server-health-poll"] as const

type OpenCodeServerHealthCacheEntry = {
  time: number
  promise: Promise<boolean>
}

function healthFetchKey(fetchFn: typeof globalThis.fetch | undefined) {
  if (!fetchFn) return "default"
  const existing = healthFetchIds.get(fetchFn)
  if (existing !== undefined) return String(existing)
  nextHealthFetchId += 1
  healthFetchIds.set(fetchFn, nextHealthFetchId)
  return String(nextHealthFetchId)
}

function opencodeServerHealthCacheUrl(url: string) {
  try {
    const parsed = new URL(url)
    parsed.username = ""
    parsed.password = ""
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return url.replace(/^(https?:\/\/)[^/@]+@/, "$1").replace(/\/+$/, "")
  }
}

export function opencodeServerHealthQueryKey(input: { fetchKey: string; url: string }) {
  return [...opencodeServerHealthQueryRoot, input.fetchKey, opencodeServerHealthCacheUrl(input.url)] as const
}

export function resetOpenCodeServerHealthCacheForTest() {
  queryClient.removeQueries({ queryKey: opencodeServerHealthQueryRoot })
  queryClient.removeQueries({ queryKey: opencodeServerHealthPollQueryRoot })
}

function opencodeServerHealthPollQueryKey(input: { fetchKey: string; url: string }) {
  return [...opencodeServerHealthPollQueryRoot, input.fetchKey, opencodeServerHealthCacheUrl(input.url)] as const
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function checkOpenCodeServerHealthCached(input: {
  url: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  now?: () => number
}) {
  const queryKey = opencodeServerHealthQueryKey({
    fetchKey: healthFetchKey(input.fetch),
    url: input.url,
  })
  const cached = queryClient.getQueryData<OpenCodeServerHealthCacheEntry>(queryKey)
  const now = input.now?.() ?? Date.now()
  if (cached && now - cached.time < HEALTH_CACHE_MS) return cached.promise

  const sdk = createOpencodeClient({
    baseUrl: input.url,
    fetch: input.fetch,
    signal: input.signal,
  })
  const promise = sdk.global
    .health()
    .then((x) => x.data?.healthy === true)
    .catch(() => false)
    .finally(() => {
      const next = queryClient.getQueryData<OpenCodeServerHealthCacheEntry>(queryKey)
      if (next?.promise !== promise) return
      queryClient.setQueryData<OpenCodeServerHealthCacheEntry>(queryKey, {
        promise,
        time: input.now?.() ?? Date.now(),
      })
    })
  queryClient.setQueryData<OpenCodeServerHealthCacheEntry>(queryKey, { time: now, promise })
  return promise
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

// Web app connections are HTTP; the desktop app (claxedo-desktop
// src/renderer/index.tsx) additionally constructs a "sidecar" connection for
// its embedded server, so the Sidecar variant is load-bearing cross-package.
function projectsKey(key: ServerConnection.Key) {
  if (!key) return ""
  if (key === "sidecar") return "local"
  try {
    const stripped = key.replace(/^https?:\/\//, "")
    const host = stripped.split(":")[0].split("/")[0]
    // Treat session-scoped gateway URLs as distinct "servers" even if they're on localhost,
    // otherwise cloud sandboxes collapse into the same "local" bucket and reloads revert to :3000.
    if ((host === "localhost" || host === "127.0.0.1") && key.includes("/s/")) {
      return key
    }
    if (host === "localhost" || host === "127.0.0.1") return "local"
  } catch {
    // fall through
  }
  return key
}

const storedServerUrl = (x: StoredServer) => {
  const url = typeof x === "string" ? x : "type" in x ? x.http.url : x.url
  return normalizeServerUrl(url) ?? url
}

const serverContextInput = {
  name: "Server", gate: true,
  init: (props: { defaultServer: ServerConnection.Key; disableHealthCheck?: boolean; servers?: Array<ServerConnection.Any> }) => {
    const platform = usePlatform()
    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v6", "server.v5", "server.v4", "server.v3"]),
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        workspaceServer: {} as WorkspaceServerMap,
        closedProjects: {} as Record<string, string[]>,
      }),
    )

    // Merge props.servers (with password) + store.list, deduped by key (props.servers win).
    // Always include the defaultServer so current() never returns undefined on fresh starts.
    const allServers = createMemo((): Array<ServerConnection.Any> => {
      const servers = [
        ...(props.servers ?? []),
        ...store.list.map((value) =>
          typeof value === "string"
            ? { type: "http" as const, http: { url: storedServerUrl(value) } }
            : "type" in value
              ? {
                  ...value,
                  http: {
                    ...value.http,
                    url: storedServerUrl(value),
                  },
                }
              : { type: "http" as const, http: { ...value, url: storedServerUrl(value) } },
        ),
      ]

      const deduped = new Map(
        servers.map((value) => {
          const conn: ServerConnection.Any = "type" in value ? value : { type: "http", http: value }
          return [ServerConnection.key(conn), conn]
        }),
      )

      // Ensure the default server is always available as a connection
      if (!deduped.has(props.defaultServer)) {
        const url = normalizeServerUrl(props.defaultServer as string)
        if (url) {
          deduped.set(props.defaultServer, { type: "http", http: { url } })
        }
      }

      return [...deduped.values()]
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
    })

    function setActive(input: ServerConnection.Key | string) {
      const url = normalizeServerUrl(input as string)
      if (!url) return
      const key = ServerConnection.Key.make(url)
      if (state.active !== key) setState("active", key)
    }

    function add(input: string | { url: string } | ServerConnection.Http) {
      const raw = typeof input === "string" ? input : "http" in input && typeof input.http === "object" ? input.http.url : (input as { url: string }).url
      const url = normalizeServerUrl(raw)
      if (!url) return

      // If it's the default server, just switch to it
      const defaultUrl = normalizeServerUrl(props.defaultServer as string)
      if (defaultUrl && url === defaultUrl) {
        setState("active", ServerConnection.Key.make(url))
        return
      }

      // Build the connection to store
      const conn: ServerConnection.Http =
        typeof input !== "string" && "type" in input && input.type === "http"
          ? { ...input, http: { ...input.http, url } }
          : { type: "http", http: { url } }

      return batch(() => {
        const existing = store.list.findIndex((x) => storedServerUrl(x) === url)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(input: ServerConnection.Key | string) {
      const url = normalizeServerUrl(input as string)
      if (!url) return

      const list = store.list.filter((x) => storedServerUrl(x) !== url)
      const key = ServerConnection.Key.make(url)
      batch(() => {
        setStore("list", list)
        if (state.active === key) {
          const next = list[0]
          setState("active", next ? ServerConnection.Key.make(storedServerUrl(next)) : props.defaultServer)
        }
      })
    }

    createEffect(() => {
      if (!ready()) return
      if (state.active) return
      setState("active", props.defaultServer)
    })

    const isReady = createMemo(() => ready() && !!state.active)

    // current() looks up in allServers by key — carries http.password from props.servers
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )

    // Extension: Transform URL before returning (canonicalization/gateway rewrite)
    const ext = getExtensions()
    const url = createMemo(() => {
      const c = current()
      if (!c) return state.active as string
      const raw = c.http.url
      return ext.server.transformUrl?.(raw) ?? raw
    })

    const check = (url: string) => {
      // as-any: AbortSignal.timeout is newer than the bundled DOM lib in some targets.
      const signal = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout?.(3000)
      return checkOpenCodeServerHealthCached({
        url,
        fetch: platform.fetch,
        signal,
      })
    }

    const healthQuery = useQuery(() => {
      const u = url()
      return {
        queryKey: opencodeServerHealthPollQueryKey({
          fetchKey: healthFetchKey(platform.fetch),
          url: u ?? "",
        }),
        queryFn: async () => {
          if (!u) return { url: u, healthy: false }
          const quietDelay = fastSessionSwitchAnyQuietDelay()
          if (quietDelay > 0) await wait(quietDelay)
          return { url: u, healthy: await check(u) }
        },
        enabled: isReady() && !!u && !props.disableHealthCheck,
        staleTime: HEALTH_CACHE_MS,
        refetchInterval: 10_000,
        refetchIntervalInBackground: true,
      }
    })

    const healthy = () => (healthQuery.data?.url === url() && !props.disableHealthCheck ? healthQuery.data.healthy : undefined)

    const origin = createMemo(() => projectsKey(state.active))
    const projectsList = createMemo(() => store.projects[origin()] ?? [])
    const isLocal = createMemo(() => {
      const c = current()
      return (c?.type === "sidecar" && c.variant === "base") || origin() === "local"
    })

    return {
      ready: isReady,
      healthy,
      isLocal,
      get key() {
        return state.active
      },
      get url() {
        return url()
      },
      get name() {
        return serverDisplayName(current())
      },
      get current() {
        return current()
      },
      get list() {
        return allServers()
      },
      forWorkspace(worktree: string) {
        const hit = store.workspaceServer[worktree]
        return hit ? normalizeServerUrl(hit) ?? hit : undefined
      },
      rememberWorkspace(worktree: string, url: string) {
        const normalized = normalizeServerUrl(url)
        if (!normalized) return
        setStore("workspaceServer", worktree, normalized)
      },
      setActive,
      add,
      remove,
      projects: {
        list: projectsList,
        open(directory: string) {
          if (!validWorktree(directory)) return
          const key = origin()
          if (!key) return
          // Remove from closed list when explicitly opening
          const closed = store.closedProjects[key] ?? []
          if (closed.includes(directory)) {
            setStore("closedProjects", key, closed.filter((x) => x !== directory))
          }
          const current = store.projects[key] ?? []
          if (current.find((x) => x.worktree === directory)) return
          setStore("projects", key, [{ worktree: directory, expanded: true }, ...current])
        },
        close(directory: string) {
          if (!validWorktree(directory)) return
          const key = origin()
          if (!key) return
          // Add to closed list to prevent re-sync from API
          const closed = store.closedProjects[key] ?? []
          if (!closed.includes(directory)) {
            setStore("closedProjects", key, [...closed, directory])
          }
          const current = store.projects[key] ?? []
          setStore(
            "projects",
            key,
            current.filter((x) => x.worktree !== directory),
          )
        },
        remove(directory: string) {
          if (!validWorktree(directory)) return
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          if (!current.some((x) => x.worktree === directory)) return
          setStore(
            "projects",
            key,
            current.filter((x) => x.worktree !== directory),
          )
        },
        isClosed(directory: string) {
          if (!validWorktree(directory)) return false
          const key = origin()
          if (!key) return false
          const closed = store.closedProjects[key] ?? []
          return closed.includes(directory)
        },
        sync(directories: string[]) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const expanded = new Map(current.map((x) => [x.worktree, x.expanded]))
          const seen = new Set<string>()
          const next = directories
            .filter(validWorktree)
            .filter((worktree) => {
              if (seen.has(worktree)) return false
              seen.add(worktree)
              return true
            })
            .map((worktree) => ({ worktree, expanded: expanded.get(worktree) ?? true }))

          setStore("projects", key, next)
        },
        expand(directory: string) {
          if (!validWorktree(directory)) return
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        collapse(directory: string) {
          if (!validWorktree(directory)) return
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        move(directory: string, toIndex: number) {
          if (!validWorktree(directory)) return
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("projects", key, result)
        },
        last() {
          const key = origin()
          if (!key) return
          return store.lastProject[key]
        },
        touch(directory: string) {
          const key = origin()
          if (!key) return
          setStore("lastProject", key, directory)
        },
      },
    }
  },
}
export const { use: useServer, provider: ServerProvider } = createSimpleContext<ReturnType<typeof serverContextInput.init>, { defaultServer: ServerConnection.Key; disableHealthCheck?: boolean; servers?: Array<ServerConnection.Any> }>(serverContextInput)
