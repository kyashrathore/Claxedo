import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"
import { validWorktree } from "@claxedo/utils/worktree"
import { getExtensions } from "@opencode-ai/app-shared"
import { createDebugLogger } from "../utils/debug"
import { isDemoMode } from "../../utils/api"

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
      url.port = "4096"
      return url.toString().replace(/\/+$/, "")
    }
  } catch {
    return withProtocol.replace(/\/+$/, "")
  }
  return withProtocol.replace(/\/+$/, "")
}

export function serverDisplayName(conn?: ServerConnection.Any | string) {
  if (!conn) return ""
  const url = typeof conn === "string" ? conn : conn.http.url
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

// Compatibility namespace matching upstream's typed server connections.
// In our cloud/web app all connections are HTTP, but upstream components
// import these types so we must export them.
export namespace ServerConnection {
  type Base = { displayName?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  export type Http = { type: "http"; http: HttpBase } & Base
  export type Sidecar = { type: "sidecar"; http: HttpBase } & ({ variant: "base" } | { variant: "wsl"; distro: string }) & Base
  export type Ssh = { type: "ssh"; host: string; http: HttpBase } & Base

  export type Any = Http | Sidecar | Ssh

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar":
        return Key.make(conn.variant === "wsl" ? `wsl:${(conn as any).distro}` : "sidecar")
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }

  /** Wrap a plain URL string as an Http connection for compat */
  export function fromUrl(url: string): Http {
    return { type: "http", http: { url } }
  }
}

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

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: { defaultServer: ServerConnection.Key; disableHealthCheck?: boolean; servers?: Array<ServerConnection.Any> }) => {
    const platform = usePlatform()
    const debug = createDebugLogger("server.health", "server:health", {
      legacyKey: "opencode.debug.terminal",
    })
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
      healthy: undefined as boolean | undefined,
    })

    const healthy = () => state.healthy

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
      const signal = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout?.(3000)
      const sdk = createOpencodeClient({
        baseUrl: url,
        fetch: platform.fetch,
        signal,
      })
      return sdk.global
        .health()
        .then((x) => x.data?.healthy === true)
        .catch(() => false)
    }

    createEffect(() => {
      const u = url()
      if (!u) return

      debug.log("watch", { url: u })
      setState("healthy", undefined)

      let alive = true
      let busy = false

      const run = () => {
        if (busy) {
          if (debug.enabled(2)) {
            debug.verbose("probe skip", { reason: "busy", url: u })
          }
          return
        }
        busy = true
        const start = Date.now()
        if (debug.enabled(2)) {
          debug.verbose("probe start", { url: u })
        }
        void check(u)
          .then((next) => {
            if (!alive) return
            const prev = state.healthy
            setState("healthy", next)
            debug.log("probe result", {
              url: u,
              healthy: next,
              prev,
              ms: Date.now() - start,
            })
          })
          .finally(() => {
            busy = false
          })
      }

      run()
      const interval = setInterval(run, 10_000)

      onCleanup(() => {
        alive = false
        clearInterval(interval)
        if (debug.enabled(2)) {
          debug.verbose("watch cleanup", { url: u })
        }
      })
    })

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
})
