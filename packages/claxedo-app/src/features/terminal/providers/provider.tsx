import { createStore, produce } from "solid-js/store"
import { batch, createContext, createEffect, createRoot, on, onCleanup, useContext, type ParentProps } from "solid-js"
import { useSDK, useClaxedoEventsOptional } from "@/features/terminal/app-ports"
import { Persist, persisted, removePersisted } from "@/platform/persistence/persist"
import { scopeUrl } from "@/lib/url"
import { clearInitialCommandMarker } from "@/features/terminal/core/terminal-recovery"
import { pickPersistBufferEvictions } from "@/features/terminal/core/terminal-buffer"
import { mergeCreatedTerminal, type LocalPTY, type NewTerminalInput } from "@/features/terminal/providers/shared"
import { legacyDirectoryFromRouteKey } from "@/platform/identity/route"
import { legacyTerminalPersistScopeKey, terminalScopeKey } from "@/platform/identity/session-view-key"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { DEFAULT_LOCAL_CLAXEDO_SERVER_URL } from "@/platform/api/local-server"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { createTransport } from "@/platform/runtime/transport"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { terminalPtyApiPath } from "@/features/terminal/core/terminal-connection"
import { terminalLaunchCommand } from "@/features/terminal/core/terminal-launch-command"
import { createRefCountedResourceCache } from "@/platform/sync/live-resource-cache"
export type { LocalPTY } from "@/features/terminal/providers/shared"

const WORKSPACE_KEY = "__workspace__"
const MAX_TERMINAL_SESSIONS = 20
const SERVER_SCOPED_PERSIST = import.meta.env.VITE_SERVER_SCOPED_PERSIST === "true"

type TerminalSession = ReturnType<typeof createTerminalSession>

type TerminalCacheEntry = {
  value: TerminalSession
  release: VoidFunction
}

const scope = scopeUrl

function obj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function bool(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function decodeDirectory(value: string) {
  if (value.startsWith("/")) return value
  return legacyDirectoryFromRouteKey(value) ?? value
}

export function workspaceRelativeCwd(workspaceDir: string, cwd: string | undefined) {
  if (!cwd) return undefined
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\/.test(cwd)
  const posixAbsolute = cwd.startsWith("/")
  if (!windowsAbsolute && !posixAbsolute) return cwd

  // Runtime PTY routes accept only workspace-relative cwd values. Normalize
  // separators in the browser so Windows drive paths compare correctly without
  // weakening the runtime's absolute-path/traversal checks.
  const workspace = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "")
  const target = cwd.replace(/\\/g, "/").replace(/\/+$/, "")
  const comparableWorkspace = windowsAbsolute ? workspace.toLowerCase() : workspace
  const comparableTarget = windowsAbsolute ? target.toLowerCase() : target
  if (comparableTarget === comparableWorkspace) return undefined
  if (comparableTarget.startsWith(`${comparableWorkspace}/`)) return target.slice(workspace.length + 1)
  return undefined
}

function titleNumber(title: string) {
  const m = title.match(/^Terminal (\d+)$/)
  if (!m) return
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return
  return n
}

function pty(value: unknown): LocalPTY | undefined {
  if (!obj(value)) return

  const id = str(value.id)
  if (!id) return

  const title = str(value.title) ?? ""
  const cwd = str(value.cwd)
  const rows = num(value.rows)
  const cols = num(value.cols)
  const buffer = str(value.buffer)
  const modeSequences = str(value.modeSequences)
  const wasAltScreen = bool(value.wasAltScreen)
  const wasAtBottom = bool(value.wasAtBottom)
  const scrollY = num(value.scrollY)
  const cursor = num(value.cursor)
  const initialCommand = str(value.initialCommand)
  const sessionId = str(value.sessionId)
  const createRequestId = str(value.createRequestId)
  const direct = num(value.titleNumber)

  return {
    id,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(createRequestId !== undefined ? { createRequestId } : {}),
    title,
    titleNumber: direct && direct > 0 ? direct : (titleNumber(title) ?? 0),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
    ...(buffer !== undefined ? { buffer } : {}),
    ...(modeSequences !== undefined ? { modeSequences } : {}),
    ...(wasAltScreen !== undefined ? { wasAltScreen } : {}),
    ...(wasAtBottom !== undefined ? { wasAtBottom } : {}),
    ...(scrollY !== undefined ? { scrollY } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(initialCommand !== undefined ? { initialCommand } : {}),
  }
}

function migrateTerminalState(value: unknown) {
  if (!obj(value)) return value

  const seen = new Set<string>()
  const all = (Array.isArray(value.all) ? value.all : []).flatMap((item) => {
    const next = pty(item)
    if (!next || seen.has(next.id)) return []
    seen.add(next.id)
    return [next]
  })

  const active = str(value.active)

  return {
    active: active && seen.has(active) ? active : all[0]?.id,
    all,
  }
}

function terminalPersistTarget(url: string, dir: string) {
  return SERVER_SCOPED_PERSIST
    ? Persist.serverWorkspace(url, dir, "terminal.v2")
    : Persist.scoped(dir, undefined, "terminal.v2")
}

// Ref-counted so multiple provider instances scoped to the same directory
// share one live terminal session and dispose it once, after the last releases.
const sharedTerminalCache = createRefCountedResourceCache<TerminalSession>(MAX_TERMINAL_SESSIONS)

type TerminalSessionOptions = {
  claxedoServerUrl?: string
  claxedoEvents?: ReturnType<typeof useClaxedoEventsOptional>
  /**
   * Cloud-workspace routing hooks. When provided alongside
   * `request`, PTY lifecycle calls (create/update/clone/delete) route
   * through the Workspace Relay for cloud workspaces. Local workspaces
   * keep the legacy direct fetch.
   */
  request?: typeof fetch
  resolveWorkspaceRuntime?: (input: { directory: string }) => Promise<{
    kind: "cloud" | "local" | "user-hosted"
    workspaceId?: string
  } | null>
}

async function ptyResponse<T>(res: Response): Promise<T> {
  if (res.ok) return res.json() as Promise<T>
  const text = await res.text().catch(() => "")
  // Keep the server's response class available to the pending-create owner.
  // A rejected 4xx conclusively means no PTY will appear; a transport failure
  // does not, because the server may have created one before the response was
  // lost. `Error` itself drops arbitrary HTTP information across this layer.
  const error = new Error(text || `PTY request failed: ${res.status}`)
  Object.defineProperty(error, "status", { value: res.status })
  throw error
}

const acquireTerminalSession = (
  key: string,
  sdk: ReturnType<typeof useSDK>,
  dir: string,
  options?: TerminalSessionOptions,
): TerminalCacheEntry =>
  sharedTerminalCache.acquire(key, () =>
    createRoot((dispose) => ({
      value: createTerminalSession(sdk, dir, options),
      dispose,
    })),
  )

export function createTerminalSession(sdk: ReturnType<typeof useSDK>, dir: string, options?: TerminalSessionOptions) {
  const url = scope(sdk.url)
  const persistScope = terminalScopeKey(dir)
  const currentPersistTarget = terminalPersistTarget(url, persistScope)
  const [store, setStore, _, ready] = persisted(
    {
      ...currentPersistTarget,
      migrate: migrateTerminalState,
    },
    createStore<{
      active?: string
      all: LocalPTY[]
    }>({
      all: [],
    }),
  )

  const legacyPersistScope = legacyTerminalPersistScopeKey(persistScope)
  if (legacyPersistScope !== persistScope) {
    const legacyPersistTarget = terminalPersistTarget(url, legacyPersistScope)
    const [legacyStore, , , legacyReady] = persisted(
      {
        ...legacyPersistTarget,
        migrate: migrateTerminalState,
      },
      createStore<{
        active?: string
        all: LocalPTY[]
      }>({
        all: [],
      }),
    )

    const setLegacyTerminalPersistedState = () => {
      batch(() => {
        setStore("all", legacyStore.all.map((pty) => ({ ...pty })))
        setStore(
          "active",
          legacyStore.active && legacyStore.all.some((pty) => pty.id === legacyStore.active)
            ? legacyStore.active
            : legacyStore.all[0]?.id,
        )
      })
    }

    const migrateLegacyTerminalPersistedState = () => {
      if (!ready() || !legacyReady()) return
      if (store.all.length > 0 || legacyStore.all.length === 0) return
      setLegacyTerminalPersistedState()
      void removePersisted(legacyPersistTarget)
    }

    migrateLegacyTerminalPersistedState()
    createEffect(() => {
      if (!ready() || !legacyReady()) return
      if (store.all.length > 0 || legacyStore.all.length === 0) return
      setLegacyTerminalPersistedState()
      void removePersisted(legacyPersistTarget)
    })
  }

  // Helper: subscribe to PTY events from ClaxedoEventsProvider (claxedo mode)
  // or fall back to SDK events (vanilla mode). ClaxedoEvent has flat structure
  // (event.id / event.info), SDK events use event.properties.*.
  const ptyEvent = <T extends "pty.exited" | "pty.created" | "pty.updated" | "pty.deleted">(
    type: T,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (props: any) => void,
  ): (() => void) => {
    if (options?.claxedoEvents) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return options.claxedoEvents.on(type, (event: any) => handler(event))
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return sdk.event.on(type, (event: any) => handler(event.properties))
  }

  const unsub = ptyEvent("pty.exited", ({ id }: { id: string }) => {
    if (!store.all.some((x) => x.id === id)) return
    batch(() => {
      setStore(
        "all",
        store.all.filter((x) => x.id !== id),
      )
      if (store.active === id) {
        const remaining = store.all.filter((x) => x.id !== id)
        setStore("active", remaining[0]?.id)
      }
    })
    clearInitialCommandMarker(id)
  })
  onCleanup(unsub)

  const unsubCreated = ptyEvent("pty.created", ({ info }: { info: { id: string; sessionId?: string; createRequestId?: string; title?: string; cwd?: string } }) => {
    if (!info?.id) return
    setStore("all", (all) => {
      return mergeCreatedTerminal(all, {
        id: info.id,
        sessionId: info.sessionId,
        createRequestId: info.createRequestId,
        title: info.title,
        cwd: info.cwd,
      })
    })
    if (!store.active) setStore("active", info.id)
  })
  onCleanup(unsubCreated)

  const unsubUpdated = ptyEvent("pty.updated", ({ info }: { info: { id: string; sessionId?: string; title?: string; cwd?: string } }) => {
    const index = store.all.findIndex((x) => x.id === info.id)
    if (index === -1) return
    const cur = store.all[index]
    if (info.title === undefined && info.cwd === undefined && info.sessionId === undefined) return
    if (
      (info.title ?? cur.title) === cur.title
      && (info.cwd ?? cur.cwd) === cur.cwd
      && (info.sessionId ?? cur.sessionId) === cur.sessionId
    ) return
    setStore("all", index, (existing) => ({
      ...existing,
      title: info.title ?? existing.title,
      cwd: info.cwd ?? existing.cwd,
      sessionId: info.sessionId ?? existing.sessionId,
    }))
  })
  onCleanup(unsubUpdated)

  const unsubDeleted = ptyEvent("pty.deleted", ({ id }: { id: string }) => {
    if (!store.all.some((x) => x.id === id)) return
    batch(() => {
      setStore(
        "all",
        store.all.filter((x) => x.id !== id),
      )
      if (store.active === id) {
        const remaining = store.all.filter((x) => x.id !== id)
        setStore("active", remaining[0]?.id)
      }
    })
    clearInitialCommandMarker(id)
  })
  onCleanup(unsubDeleted)

  // Hoist claxedo-server base URL and port once for all method bodies
  const claxedoBase = options?.claxedoServerUrl ?? DEFAULT_LOCAL_CLAXEDO_SERVER_URL
  const customRequest = options?.request
  const decodedDir = decodeDirectory(dir)
  const scopedWorkspace = sdk.workspace(decodedDir)
  const workspaceRef = sessionWorkspaceRuntimeRef({ directory: decodedDir })
  const workspaceId = scopedWorkspace?.workspaceId ?? workspaceRef?.workspaceId
  const workspaceKind = scopedWorkspace?.kind ?? workspaceRef?.kind
  let resolvedWorkspace: Promise<{ workspaceId?: string | null; kind?: "local" | "cloud" | "user-hosted" | null } | null | undefined> | undefined
  const workspaceRuntime = async () => {
    const workspace = workspaceId
      ? { workspaceId, kind: workspaceKind ?? "user-hosted" }
      : await (resolvedWorkspace ??= options?.resolveWorkspaceRuntime?.({ directory: decodedDir }).catch(() => null))
    const resolvedWorkspaceId = workspace?.kind === "local" ? undefined : (workspace?.workspaceId ?? undefined)
    return {
      workspaceId: resolvedWorkspaceId,
      transport: createTransport({
        placement: {
          ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
          hosting: "workspace",
          transport: resolvedWorkspaceId && centralTransportForServer(claxedoBase) !== "loopback" ? "workspace-relay" : "loopback",
        },
        serverUrl: claxedoBase,
        directory: resolvedWorkspaceId ? undefined : decodedDir,
        request: customRequest ?? authFetch,
        resolveWorkspaceRuntime: options?.resolveWorkspaceRuntime,
      }),
    }
  }
  const ptyPath = (path: string, resolvedWorkspaceId?: string) => {
    return terminalPtyApiPath({
      suffix: path,
      ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : { directory: decodedDir }),
    })
  }
  const ptyFetch = async (path: string, init?: RequestInit) => {
    const runtime = await workspaceRuntime()
    return runtime.transport.fetch(ptyPath(path, runtime.workspaceId), init)
  }
  const claxedoPort = (() => {
    // NEVER fall back to a constant port. This value becomes `CLAXEDO_PORT` in
    // every terminal's environment, and the agent notify hook
    // (`~/.workspace-runtime/hooks/notify.sh`) POSTs its lifecycle events there
    // — so a wrong value means terminal coding agents show no status at all,
    // SILENTLY, because notify.sh discards its curl output.
    //
    // The old code returned the historical fixed dev port both when the URL had no explicit port and
    // when it failed to parse. That is right only for the dev server, which
    // once genuinely used that port — which is exactly why this stayed invisible. The
    // PACKAGED app's embedded server binds an EPHEMERAL port (61435, 61883 and
    // 54728 observed across runs on 2026-08-06), and `lsof`/`curl` confirmed
    // nothing listens on the guessed port there, so every hook POST was swallowed. Same
    // failure shape as the `CLAXEDO_PORT=80` defect fixed in claxedo-server's
    // `embeddedRuntimeTargetUrl`, reintroduced downstream by a different
    // wrong constant.
    //
    // A missing port is legitimate (a plain http/https origin), so that case
    // derives the scheme default. An UNPARSEABLE base is not legitimate — it
    // means the caller handed us something that is not an origin, and guessing
    // a port there is what made this class of bug undetectable. Return
    // undefined and let the caller omit the variable rather than inject a lie.
    try {
      const u = new URL(claxedoBase)
      if (u.port) return u.port
      return u.protocol === "https:" ? "443" : "80"
    } catch {
      return undefined
    }
  })()

  return {
    ready,
    all: () => [...store.all],
    active: () => store.active,
    ensure(input: Partial<LocalPTY> & { id: string }) {
      const index = store.all.findIndex((item) => item.id === input.id)
      if (index !== -1) {
        setStore("all", index, (existing) => ({
          ...existing,
          title: input.title ?? existing.title,
          cwd: input.cwd ?? existing.cwd,
          sessionId: input.sessionId ?? existing.sessionId,
          createRequestId: input.createRequestId ?? existing.createRequestId,
          initialCommand: existing.initialCommand ?? input.initialCommand,
        }))
        return
      }
      setStore("all", (all) => {
        const merged = mergeCreatedTerminal(all, {
          id: input.id,
          sessionId: input.sessionId,
          createRequestId: input.createRequestId,
          title: input.title,
          cwd: input.cwd,
        })
        const next = merged.findIndex((item) => item.id === input.id)
        if (next === -1 || !input.initialCommand) return merged
        return merged.map((item, i) => (i === next ? { ...item, initialCommand: input.initialCommand } : item))
      })
      if (!store.active) setStore("active", input.id)
    },
    new(input: NewTerminalInput = {}): Promise<string | undefined> {
      const existingTitleNumbers = new Set(
        store.all.flatMap((pty) => {
          const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
          if (direct !== undefined) return [direct]
          const parsed = titleNumber(pty.title)
          if (parsed === undefined) return []
          return [parsed]
        }),
      )

      const nextNumber =
        Array.from({ length: existingTitleNumbers.size + 1 }, (_, index) => index + 1).find(
          (number) => !existingTitleNumbers.has(number),
        ) ?? 1

      // Use provided title or default to "Terminal N"
      const terminalTitle = input.title ? `${input.title} ${nextNumber}` : `Terminal ${nextNumber}`
      const launch = terminalLaunchCommand(input.initialCommand)

      const ptyBody = {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.createRequestId ? { createRequestId: input.createRequestId } : {}),
        title: terminalTitle,
        ...(workspaceId ? {} : { cwd: workspaceRelativeCwd(decodedDir, sdk.directory) }),
        ...(launch ? launch : input.initialCommand ? { initialCommand: input.initialCommand } : {}),
        // Pass agent hooks environment variables
        // CLAXEDO_TAB_ID will be set to the PTY ID since the tab is created after
        // The listener will find the tab by terminalId
        env: {
          CLAXEDO_PORT: claxedoPort,
          CLAXEDO_WORKSPACE_ID: workspaceId ?? dir,
          // When restoring a closed terminal (Cmd+Shift+T), pass the old PTY ID
          // via env since the generated SDK strips unknown body fields.
          // The server reads this to rename/restore disk history.
          ...(input.previousPtyId ? { previousPtyId: input.previousPtyId } : {}),
        },
      }

      return ptyFetch(``, {
        method: "POST",
        body: JSON.stringify(ptyBody),
      })
        .then((res) => ptyResponse<{ id: string; sessionId?: string; createRequestId?: string; title: string; cwd?: string }>(res))
        .then((pty) => {
          const id = pty.id
          if (!id) return undefined
          setStore("all", (all) => {
            const merged = mergeCreatedTerminal(all, {
              id,
              sessionId: pty.sessionId ?? input.sessionId,
              createRequestId: pty.createRequestId,
              title: terminalTitle,
              cwd: pty.cwd,
            })
            const idx = merged.findIndex((item) => item.id === id)
            if (idx === -1) return merged
            return merged
          })
          setStore("active", id)
          return id
        })
    },
    update(pty: Partial<LocalPTY> & { id: string }) {
      const index = store.all.findIndex((x) => x.id === pty.id)
      if (index === -1) return
      // Preserve the Solid store node so keyed PTY renders only remount when
      // the PTY identity actually changes (for example clone/recovery).
      batch(() => {
        for (const [key, value] of Object.entries(pty)) {
          setStore("all", index, key as keyof LocalPTY, value as LocalPTY[keyof LocalPTY])
        }
        // This is where a terminal's serialized scrollback enters the store
        // (mount cleanup calls `update` with the snapshot), so it is where the
        // combined snapshots have to be brought back inside budget. Per-buffer
        // trimming happens upstream in `preparePersistBuffer`; only the sum is
        // decided here, because only here is the whole store visible.
        const evict = new Set(pickPersistBufferEvictions({
          terminals: store.all,
          keep: [pty.id, store.active],
        }))
        if (evict.size === 0) return
        for (const [position, terminal] of store.all.entries()) {
          if (!evict.has(terminal.id)) continue
          // Snapshot only. The terminal keeps its identity, title and cwd — it
          // just restores from the PTY stream instead of from localStorage.
          setStore("all", position, "buffer", undefined)
          setStore("all", position, "cursor", undefined)
          setStore("all", position, "scrollY", undefined)
        }
      })
      ptyFetch(`/${pty.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: pty.title,
          size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
        }),
      }).catch(() => {})
    },
    async clone(id: string, sessionId = store.all.find((item) => item.id === id)?.sessionId): Promise<string | undefined> {
      const index = store.all.findIndex((x) => x.id === id)
      const pty = store.all[index]
      if (!pty) return undefined
      const cwd = pty.cwd ?? sdk.directory
      const runtime = await workspaceRuntime()
      const cloneCwd = runtime.workspaceId ? cwd : workspaceRelativeCwd(decodedDir, cwd)
      const clone = await runtime.transport.fetch(ptyPath(``, runtime.workspaceId), {
        method: "POST",
        body: JSON.stringify({
          ...(sessionId ? { sessionId } : {}),
          title: pty.title,
          ...(cloneCwd ? { cwd: cloneCwd } : {}),
          env: {
            CLAXEDO_PORT: claxedoPort,
            CLAXEDO_WORKSPACE_ID: workspaceId ?? dir,
            previousPtyId: id,
          },
        }),
      })
        .then((res) => ptyResponse<{ id: string; title: string; cwd?: string }>(res))
        .catch(() => {
          return undefined
        })
      if (!clone?.id) return undefined

      const active = store.active === pty.id

      batch(() => {
        setStore("all", index, {
          ...pty,
          id: clone.id,
          title: clone.title ?? pty.title,
          cwd: clone.cwd ?? pty.cwd,
          // The replacement shell is brand new — no TUI is running behind it.
          // The mount reads this to skip the live-TUI redraw paths that would
          // otherwise clear the screen we are about to restore into.
          recreated: true,
        })
        if (active) {
          setStore("active", clone.id)
        }
      })
      return clone.id
    },
    open(id: string) {
      setStore("active", id)
    },
    next() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const nextIndex = (index + 1) % store.all.length
      setStore("active", store.all[nextIndex]?.id)
    },
    previous() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const prevIndex = index === 0 ? store.all.length - 1 : index - 1
      setStore("active", store.all[prevIndex]?.id)
    },
    async close(id: string) {
      batch(() => {
        const filtered = store.all.filter((x) => x.id !== id)
        if (store.active === id) {
          const index = store.all.findIndex((f) => f.id === id)
          const next = index > 0 ? index - 1 : 0
          setStore("active", filtered[next]?.id)
        }
        setStore("all", filtered)
      })

      await ptyFetch(`/${id}`, { method: "DELETE" }).catch(() => {})
    },
    move(id: string, to: number) {
      const index = store.all.findIndex((f) => f.id === id)
      if (index === -1) return
      setStore(
        "all",
        produce((all) => {
          all.splice(to, 0, all.splice(index, 1)[0])
        }),
      )
    },
    removeStale(ids: Set<string>) {
      if (ids.size === 0) return
      const filtered = store.all.filter((x) => !ids.has(x.id))
      if (filtered.length === store.all.length) return
      batch(() => {
        setStore("all", filtered)
        if (store.active && ids.has(store.active)) {
          setStore("active", filtered[0]?.id)
        }
      })
    },
    trim(id: string) {
      const index = store.all.findIndex((x) => x.id === id)
      if (index === -1) return
      const pty = store.all[index]
      if (!pty.buffer && pty.cursor === undefined && pty.scrollY === undefined) return
      // Use path-based updates to preserve the SolidJS store node proxy identity.
      // A function updater returning a new object would create a new proxy, causing
      // keyed terminal mounts to remount <Terminal> on every connect,
      // creating an infinite reconnect loop.
      batch(() => {
        setStore("all", index, "buffer", undefined)
        setStore("all", index, "cursor", undefined)
        setStore("all", index, "scrollY", undefined)
      })
    },
    trimAll() {
      setStore("all", (all) => {
        const next = all.map((pty) => {
          if (!pty.buffer && pty.cursor === undefined && pty.scrollY === undefined) return pty
          return {
            ...pty,
            buffer: undefined,
            cursor: undefined,
            scrollY: undefined,
          }
        })
        if (next.every((pty, index) => pty === all[index])) return all
        return next
      })
    },
  }
}

function createTerminalContextValue() {
  const sdk = useSDK()
  const platform = usePlatform()
  const claxedoEvents = useClaxedoEventsOptional()
  const claxedoServerUrl = getClaxedoServerUrl()
  const terminalOptions: TerminalSessionOptions = {
    claxedoEvents,
    claxedoServerUrl,
    request: platform.fetch ?? authFetch,
    resolveWorkspaceRuntime: async ({ directory }) => {
      const decoded = decodeDirectory(directory)
      const scopedWorkspace = sdk.workspace(decoded)
      if (scopedWorkspace) return scopedWorkspace
      const workspaceRef = sessionWorkspaceRuntimeRef({ directory: decoded })
      const workspaceId = workspaceRef?.workspaceId
      if (workspaceId) return { kind: workspaceRef.kind, workspaceId }
      const workspace = await resolveWorkspaceRuntime({
        baseUrl: claxedoServerUrl,
        request: platform.fetch ?? authFetch,
        directory: workspaceId ? undefined : decoded,
        workspaceId,
      })
      if (!workspace?.kind) return null
      return {
        kind: workspace.kind,
        workspaceId: workspace.workspaceId,
      }
    },
  }
  const cache = new Map<string, TerminalCacheEntry>()

  const disposeAll = () => {
    for (const entry of cache.values()) {
      entry.release()
    }
    cache.clear()
  }

  const load = (dir: string) => {
    const key = SERVER_SCOPED_PERSIST ? `${scope(sdk.url)}:${dir}:${WORKSPACE_KEY}` : `${dir}:${WORKSPACE_KEY}`
    const existing = cache.get(key)
    if (existing) {
      return existing.value
    }
    const entry = acquireTerminalSession(key, sdk, dir, terminalOptions)
    cache.set(key, entry)
    return entry.value
  }

  let workspace: TerminalSession | undefined
  let lastWorkspace: TerminalSession | undefined

  workspace = load(terminalScopeKey(sdk.directory))
  lastWorkspace = workspace

  createEffect(() => {
    const next = load(terminalScopeKey(sdk.directory))
    workspace = next
    lastWorkspace = next
  })

  createEffect(
    on(
      () => terminalScopeKey(sdk.directory),
      (next, prev) => {
        if (!prev) return
        if (next === prev) return
        const prevEntry = cache.get(SERVER_SCOPED_PERSIST ? `${scope(sdk.url)}:${prev}:${WORKSPACE_KEY}` : `${prev}:${WORKSPACE_KEY}`)
        prevEntry?.value.trimAll()
      },
      { defer: true },
    ),
  )

  const safeWorkspace = () => {
    if (workspace) return workspace
    return lastWorkspace
  }

  onCleanup(() => {
    workspace = undefined
    disposeAll()
  })

  return {
    ready: () => safeWorkspace()?.ready() ?? false,
    all: () => safeWorkspace()?.all() ?? [],
    active: () => safeWorkspace()?.active(),
    ensure: (pty: Partial<LocalPTY> & { id: string }) => {
      safeWorkspace()?.ensure(pty)
    },
    new: (input?: NewTerminalInput) => {
      const current = safeWorkspace()
      if (!current) return
      return current.new(input)
    },
    update: (pty: Partial<LocalPTY> & { id: string }) => {
      safeWorkspace()?.update(pty)
    },
    clone: (id: string, sessionId?: string) => {
      const current = safeWorkspace()
      if (!current) return undefined
      return current.clone(id, sessionId)
    },
    open: (id: string) => {
      safeWorkspace()?.open(id)
    },
    close: (id: string) => safeWorkspace()?.close(id),
    move: (id: string, to: number) => {
      safeWorkspace()?.move(id, to)
    },
    next: () => {
      safeWorkspace()?.next()
    },
    previous: () => {
      safeWorkspace()?.previous()
    },
    removeStale: (ids: Set<string>) => safeWorkspace()?.removeStale(ids),
    trim: (id: string) => safeWorkspace()?.trim(id),
    trimAll: () => safeWorkspace()?.trimAll(),
  }
}

const TerminalCtx = createContext<ReturnType<typeof createTerminalContextValue>>()

export function useTerminal() {
  const value = useContext(TerminalCtx)
  if (!value) throw new Error("Terminal context must be used within a context provider")
  return value
}

export function TerminalProvider(props: ParentProps) {
  return <TerminalCtx.Provider value={createTerminalContextValue()}>{props.children}</TerminalCtx.Provider>
}

export function useOptionalTerminal() {
  return useContext(TerminalCtx)
}
