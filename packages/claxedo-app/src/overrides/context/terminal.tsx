import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createRoot, onCleanup, useContext } from "solid-js"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { clearInitialCommandMarker } from "../components/terminal-recovery"
import { mergeCreatedTerminal, type LocalPTY } from "./terminal-shared"
import { base64Encode } from "@opencode-ai/util/encode"
import { createDebugLogger } from "../utils/debug"
export type { LocalPTY } from "./terminal-shared"

const WORKSPACE_KEY = "__workspace__"
const MAX_TERMINAL_SESSIONS = 20
const SERVER_SCOPED_PERSIST = import.meta.env.VITE_SERVER_SCOPED_PERSIST === "true"

type TerminalSession = ReturnType<typeof createTerminalSession>

type TerminalCacheEntry = {
  value: TerminalSession
  release: VoidFunction
}

type SharedTerminalCacheEntry = {
  value: TerminalSession
  dispose: VoidFunction
  refs: number
}

const debug = createDebugLogger("terminal.store", "terminal:store", {
  legacyKey: "opencode.debug.terminal",
})

function tlog(...args: unknown[]) {
  debug.log(...args)
}

function tvlog(...args: unknown[]) {
  debug.verbose(...args)
}

const sharedTerminalCache = new Map<string, SharedTerminalCacheEntry>()

const releaseTerminalSession = (key: string) => {
  const entry = sharedTerminalCache.get(key)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) {
    tvlog("cache release", { key, refs: entry.refs, size: sharedTerminalCache.size })
    return
  }
  entry.dispose()
  sharedTerminalCache.delete(key)
  tvlog("cache disposed", { key, size: sharedTerminalCache.size })
}

const pruneTerminalCache = () => {
  if (sharedTerminalCache.size <= MAX_TERMINAL_SESSIONS) return
  for (const [key, entry] of sharedTerminalCache) {
    if (entry.refs > 0) continue
    entry.dispose()
    sharedTerminalCache.delete(key)
    tvlog("cache pruned", { key, size: sharedTerminalCache.size })
    if (sharedTerminalCache.size <= MAX_TERMINAL_SESSIONS) return
  }
}

const acquireTerminalSession = (
  key: string,
  sdk: ReturnType<typeof useSDK>,
  dir: string,
): TerminalCacheEntry => {
  const existing = sharedTerminalCache.get(key)
  if (existing) {
    existing.refs += 1
    tvlog("cache acquire existing", { key, refs: existing.refs, size: sharedTerminalCache.size })
    return {
      value: existing.value,
      release: () => releaseTerminalSession(key),
    }
  }

  const created = createRoot((dispose) => ({
    value: createTerminalSession(sdk, dir),
    dispose,
  }))

  sharedTerminalCache.set(key, {
    value: created.value,
    dispose: created.dispose,
    refs: 1,
  })
  pruneTerminalCache()
  tvlog("cache acquire new", { key, refs: 1, size: sharedTerminalCache.size })
  return {
    value: created.value,
    release: () => releaseTerminalSession(key),
  }
}

export function createTerminalSession(sdk: ReturnType<typeof useSDK>, dir: string) {
  const numberFromTitle = (title: string) => {
    const m = title.match(/^Terminal (\d+)$/)
    if (!m) return
    const n = Number(m[1])
    if (!Number.isFinite(n) || n <= 0) return
    return n
  }

  const [store, setStore, _, ready] = persisted(
    SERVER_SCOPED_PERSIST ? Persist.serverWorkspace(sdk.url, dir, "terminal.v2") : Persist.workspace(dir, "terminal.v2"),
    createStore<{
      active?: string
      all: LocalPTY[]
    }>({
      all: [],
    }),
  )

  const unsub = sdk.event.on("pty.exited", (event) => {
    const id = event.properties.id
    tlog("event pty.exited", { dir, id, known: store.all.some((x) => x.id === id) })
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

  const unsubCreated = sdk.event.on("pty.created", (event) => {
    const info = event.properties.info
    if (!info?.id) return
    const cmd = pendingInitialCommand
    const stamp = pendingInitialStamp
    pendingInitialCommand = undefined
    pendingInitialStamp = 0
    tlog("event pty.created", {
      dir,
      id: info.id,
      title: info.title,
      cwd: info.cwd,
      pendingCmd: !!cmd,
      pendingStamp: stamp || undefined,
      pendingLen: cmd?.length,
    })
    setStore("all", (all) => {
      const merged = mergeCreatedTerminal(all, { id: info.id, title: info.title, cwd: info.cwd })
      if (!cmd) return merged
      const idx = merged.findIndex((item) => item.id === info.id)
      if (idx === -1) return merged
      return merged.map((item, i) => (i === idx ? { ...item, initialCommand: cmd } : item))
    })
    if (!store.active) setStore("active", info.id)
    tvlog("after pty.created", { dir, active: store.active, ids: store.all.map((x) => x.id) })
  })
  onCleanup(unsubCreated)

  const unsubUpdated = sdk.event.on("pty.updated", (event) => {
    const info = event.properties.info
    const index = store.all.findIndex((x) => x.id === info.id)
    tlog("event pty.updated", { dir, id: info.id, index, title: info.title, cwd: info.cwd })
    if (index === -1) return
    setStore("all", index, (existing) => ({
      ...existing,
      title: info.title ?? existing.title,
      cwd: info.cwd ?? existing.cwd,
    }))
  })
  onCleanup(unsubUpdated)

  const unsubDeleted = sdk.event.on("pty.deleted", (event) => {
    const id = event.properties.id
    tlog("event pty.deleted", { dir, id, known: store.all.some((x) => x.id === id) })
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

  // Pending initial command for terminals created by new().
  // The pty.created SSE event arrives before the HTTP .then() callback,
  // so the event handler adds the PTY to the store without initialCommand.
  // The Terminal component mounts with a stale reference and never sees it.
  // This variable bridges the gap: new() sets it before the API call,
  // and the event handler consumes it when adding the PTY.
  let pendingInitialCommand: string | undefined
  let pendingInitialStamp = 0

  const meta = { migrated: false }

  // Migration effect for titleNumber
  createEffect(() => {
    if (!ready()) return
    if (meta.migrated) return
    meta.migrated = true

    setStore("all", (all) => {
      const next = all.map((pty) => {
        const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
        if (direct !== undefined) return pty
        const parsed = numberFromTitle(pty.title)
        if (parsed === undefined) return pty
        return { ...pty, titleNumber: parsed }
      })
      if (next.every((pty, index) => pty === all[index])) return all
      return next
    })
  })

  return {
    ready,
    all: () => [...store.all],
    active: () => store.active,
    new(initialCommand?: string, title?: string, previousPtyId?: string): Promise<string | undefined> {
      debug.log("new()", { dir, count: store.all.length, initialCommand, title, previousPtyId })
      tvlog("new() pre", { dir, all: store.all.map((x) => ({ id: x.id, title: x.title })), active: store.active })

      const existingTitleNumbers = new Set(
        store.all.flatMap((pty) => {
          const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
          if (direct !== undefined) return [direct]
          const parsed = numberFromTitle(pty.title)
          if (parsed === undefined) return []
          return [parsed]
        }),
      )

      const nextNumber =
        Array.from({ length: existingTitleNumbers.size + 1 }, (_, index) => index + 1).find(
          (number) => !existingTitleNumbers.has(number),
        ) ?? 1

      // Get server port from SDK URL for agent hooks
      const serverPort = (() => {
        try {
          const url = new URL(sdk.url)
          return url.port || (url.protocol === "https:" ? "443" : "80")
        } catch {
          return "7860"
        }
      })()

      // Use provided title or default to "Terminal N"
      const terminalTitle = title ? `${title} ${nextNumber}` : `Terminal ${nextNumber}`

      // Set before the API call so the pty.created event handler can pick it up.
      // The event fires before .then() resolves, so this bridges the gap.
      if (initialCommand) {
        pendingInitialCommand = initialCommand
        pendingInitialStamp = Date.now()
        tlog("new() set pending initial command", {
          dir,
          title: terminalTitle,
          pendingStamp: pendingInitialStamp,
          len: initialCommand.length,
        })
      }

      // CLAXEDO PATCH: Instrumentation — time the HTTP POST /pty round-trip
      const createStart = performance.now()
      const createParams: Parameters<typeof sdk.client.pty.create>[0] = {
        title: terminalTitle,
        // Pass agent hooks environment variables
        // CLAXEDO_TAB_ID will be set to the PTY ID since the tab is created after
        // The listener will find the tab by terminalId
        env: {
          CLAXEDO_PORT: serverPort,
          CLAXEDO_WORKSPACE_ID: dir,
          // When restoring a closed terminal (Cmd+Shift+T), pass the old PTY ID
          // via env since the generated SDK strips unknown body fields.
          // The server reads this to rename/restore disk history.
          ...(previousPtyId ? { previousPtyId } : {}),
        },
      }
      return sdk.client.pty
        .create(createParams)
        .then((pty) => {
          const createMs = Math.round(performance.now() - createStart)
          const hadPending = !!pendingInitialCommand
          const stamp = pendingInitialStamp
          pendingInitialCommand = undefined
          pendingInitialStamp = 0
          const id = pty.data?.id
          if (!id) return undefined
          tlog("new() create resolved", {
            dir,
            id,
            title: terminalTitle,
            hadPending,
            pendingStamp: stamp || undefined,
            initialLen: initialCommand?.length,
            createMs,
          })
          // eslint-disable-next-line no-console
          console.log("[terminal:timing] POST /pty", { id, createMs })
          debug.log("created", { id, title: terminalTitle, cwd: pty.data?.cwd, initialCommand })
          setStore("all", (all) => {
            const merged = mergeCreatedTerminal(all, { id, title: terminalTitle, cwd: pty.data?.cwd })
            const idx = merged.findIndex((item) => item.id === id)
            if (idx === -1) return merged
            if (!initialCommand) return merged
            if (merged[idx].initialCommand) return merged
            tlog("new() apply initial command to store", { dir, id, len: initialCommand.length })
            return merged.map((item, i) => (i === idx ? { ...item, initialCommand } : item))
          })
          setStore("active", id)
          tvlog("new() post create", { dir, id, all: store.all.map((x) => x.id), active: store.active })
          return id
        })
        .catch((e) => {
          const stamp = pendingInitialStamp
          pendingInitialCommand = undefined
          pendingInitialStamp = 0
          tlog("new() create failed", { dir, title: terminalTitle, hadInitial: !!initialCommand, pendingStamp: stamp || undefined })
          debug.log("create failed", e)
          console.error("Failed to create terminal", e)
          return undefined
        })
    },
    update(pty: Partial<LocalPTY> & { id: string }) {
      tvlog("update()", { dir, id: pty.id, patch: pty })
      const index = store.all.findIndex((x) => x.id === pty.id)
      if (index === -1) {
        tlog("update() ignored unknown PTY", { dir, id: pty.id, known: store.all.map((x) => x.id) })
        return
      }
      setStore("all", index, (existing) => ({ ...existing, ...pty }))
      sdk.client.pty
        .update({
          ptyID: pty.id,
          title: pty.title,
          size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
        })
        .catch((e) => {
          console.error("Failed to update terminal", e)
        })
    },
    async clone(id: string): Promise<string | undefined> {
      const index = store.all.findIndex((x) => x.id === id)
      const pty = store.all[index]
      if (!pty) return undefined
      const clone = await sdk.client.pty
        .create({
          title: pty.title,
          env: { previousPtyId: id },
        })
        .catch((e) => {
          console.error("Failed to clone terminal", e)
          return undefined
        })
      if (!clone?.data) return undefined

      const active = store.active === pty.id

      batch(() => {
        setStore("all", index, {
          ...pty,
          id: clone.data.id,
          title: clone.data.title ?? pty.title,
          cwd: clone.data.cwd ?? pty.cwd,
        })
        if (active) {
          setStore("active", clone.data.id)
        }
      })
      return clone.data.id
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
      tlog("close()", { dir, id, before: store.all.map((x) => x.id), active: store.active })
      batch(() => {
        const filtered = store.all.filter((x) => x.id !== id)
        if (store.active === id) {
          const index = store.all.findIndex((f) => f.id === id)
          const next = index > 0 ? index - 1 : 0
          setStore("active", filtered[next]?.id)
        }
        setStore("all", filtered)
      })

      await sdk.client.pty.remove({ ptyID: id }).catch((e) => {
        console.error("Failed to close terminal", e)
      })
      tvlog("close() post", { dir, id, after: store.all.map((x) => x.id), active: store.active })
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
      tlog("removeStale", { dir, removed: Array.from(ids), before: store.all.length, after: filtered.length })
      batch(() => {
        setStore("all", filtered)
        if (store.active && ids.has(store.active)) {
          setStore("active", filtered[0]?.id)
        }
      })
    },
  }
}

const terminalContext = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const cache = new Map<string, TerminalCacheEntry>()

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.release()
      }
      cache.clear()
    }

    const load = (dir: string) => {
      const key = SERVER_SCOPED_PERSIST ? `${sdk.url}:${dir}:${WORKSPACE_KEY}` : `${dir}:${WORKSPACE_KEY}`
      const existing = cache.get(key)
      if (existing) {
        return existing.value
      }
      const entry = acquireTerminalSession(key, sdk, dir)
      cache.set(key, entry)
      return entry.value
    }

    let workspace: TerminalSession | undefined
    let lastWorkspace: TerminalSession | undefined

    workspace = load(base64Encode(sdk.directory))
    lastWorkspace = workspace

    createEffect(() => {
      const next = load(base64Encode(sdk.directory))
      workspace = next
      lastWorkspace = next
    })

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
      new: (initialCommand?: string, title?: string, previousPtyId?: string) => {
        const current = safeWorkspace()
        if (!current) return
        return current.new(initialCommand, title, previousPtyId)
      },
      update: (pty: Partial<LocalPTY> & { id: string }) => {
        safeWorkspace()?.update(pty)
      },
      clone: (id: string) => {
        const current = safeWorkspace()
        if (!current) return undefined
        return current.clone(id)
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
    }
  },
})

export const useTerminal = terminalContext.use
export const TerminalProvider = terminalContext.provider

export function useOptionalTerminal() {
  return useContext(terminalContext.ctx)
}
