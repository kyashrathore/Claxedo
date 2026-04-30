import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createRoot, on, onCleanup, useContext } from "solid-js"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { scopeUrl } from "../utils/url"
import { clearInitialCommandMarker } from "../components/terminal-recovery"
import { mergeCreatedTerminal, type LocalPTY } from "./terminal-shared"
import { base64Encode } from "@opencode-ai/util/encode"
import { useClaxedoEventsOptional } from "@claxedo/providers/claxedo-events"
import { getClaxedoServerUrl } from "../../utils/api"
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
  const direct = num(value.titleNumber)

  return {
    id,
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

const sharedTerminalCache = new Map<string, SharedTerminalCacheEntry>()

const releaseTerminalSession = (key: string) => {
  const entry = sharedTerminalCache.get(key)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  entry.dispose()
  sharedTerminalCache.delete(key)
}

const pruneTerminalCache = () => {
  if (sharedTerminalCache.size <= MAX_TERMINAL_SESSIONS) return
  for (const [key, entry] of sharedTerminalCache) {
    if (entry.refs > 0) continue
    entry.dispose()
    sharedTerminalCache.delete(key)
    if (sharedTerminalCache.size <= MAX_TERMINAL_SESSIONS) return
  }
}

type TerminalSessionOptions = {
  claxedoServerUrl?: string
  claxedoEvents?: ReturnType<typeof useClaxedoEventsOptional>
}

const acquireTerminalSession = (
  key: string,
  sdk: ReturnType<typeof useSDK>,
  dir: string,
  options?: TerminalSessionOptions,
): TerminalCacheEntry => {
  const existing = sharedTerminalCache.get(key)
  if (existing) {
    existing.refs += 1
    return {
      value: existing.value,
      release: () => releaseTerminalSession(key),
    }
  }

  const created = createRoot((dispose) => ({
    value: createTerminalSession(sdk, dir, options),
    dispose,
  }))

  sharedTerminalCache.set(key, {
    value: created.value,
    dispose: created.dispose,
    refs: 1,
  })
  pruneTerminalCache()
  return {
    value: created.value,
    release: () => releaseTerminalSession(key),
  }
}

export function createTerminalSession(sdk: ReturnType<typeof useSDK>, dir: string, options?: TerminalSessionOptions) {
  const url = scope(sdk.url)
  const [store, setStore, _, ready] = persisted(
    {
      ...(SERVER_SCOPED_PERSIST
        ? Persist.serverWorkspace(url, dir, "terminal.v2")
        : Persist.workspace(dir, "terminal.v2")),
      migrate: migrateTerminalState,
    },
    createStore<{
      active?: string
      all: LocalPTY[]
    }>({
      all: [],
    }),
  )

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

  const unsubCreated = ptyEvent("pty.created", ({ info }: { info: { id: string; title?: string; cwd?: string } }) => {
    if (!info?.id) return
    const cmd = pendingInitialCommand
    pendingInitialCommand = undefined
    setStore("all", (all) => {
      const merged = mergeCreatedTerminal(all, { id: info.id, title: info.title, cwd: info.cwd })
      if (!cmd) return merged
      const idx = merged.findIndex((item) => item.id === info.id)
      if (idx === -1) return merged
      return merged.map((item, i) => (i === idx ? { ...item, initialCommand: cmd } : item))
    })
    if (!store.active) setStore("active", info.id)
  })
  onCleanup(unsubCreated)

  const unsubUpdated = ptyEvent("pty.updated", ({ info }: { info: { id: string; title?: string; cwd?: string } }) => {
    const index = store.all.findIndex((x) => x.id === info.id)
    if (index === -1) return
    const cur = store.all[index]
    if (info.title === undefined && info.cwd === undefined) return
    if ((info.title ?? cur.title) === cur.title && (info.cwd ?? cur.cwd) === cur.cwd) return
    setStore("all", index, (existing) => ({
      ...existing,
      title: info.title ?? existing.title,
      cwd: info.cwd ?? existing.cwd,
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

  // Pending initial command for terminals created by new().
  // The pty.created SSE event arrives before the HTTP .then() callback,
  // so the event handler adds the PTY to the store without initialCommand.
  // The Terminal component mounts with a stale reference and never sees it.
  // This variable bridges the gap: new() sets it before the API call,
  // and the event handler consumes it when adding the PTY.
  let pendingInitialCommand: string | undefined

  // Hoist claxedo-server base URL and port once for all method bodies
  const claxedoBase = options?.claxedoServerUrl ?? "http://127.0.0.1:3001"
  const claxedoPort = (() => {
    try {
      const u = new URL(claxedoBase)
      return u.port || "3001"
    } catch {
      return "3001"
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
          initialCommand: existing.initialCommand ?? input.initialCommand,
        }))
        return
      }
      setStore("all", (all) => {
        const merged = mergeCreatedTerminal(all, {
          id: input.id,
          title: input.title,
          cwd: input.cwd,
        })
        const next = merged.findIndex((item) => item.id === input.id)
        if (next === -1 || !input.initialCommand) return merged
        return merged.map((item, i) => (i === next ? { ...item, initialCommand: input.initialCommand } : item))
      })
      if (!store.active) setStore("active", input.id)
    },
    new(initialCommand?: string, title?: string, previousPtyId?: string): Promise<string | undefined> {
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
      const terminalTitle = title ? `${title} ${nextNumber}` : `Terminal ${nextNumber}`

      // Set before the API call so the pty.created event handler can pick it up.
      // The event fires before .then() resolves, so this bridges the gap.
      if (initialCommand) {
        pendingInitialCommand = initialCommand
      }

      const ptyBody = {
        title: terminalTitle,
        cwd: sdk.directory,
        // Pass agent hooks environment variables
        // CLAXEDO_TAB_ID will be set to the PTY ID since the tab is created after
        // The listener will find the tab by terminalId
        env: {
          CLAXEDO_PORT: claxedoPort,
          CLAXEDO_WORKSPACE_ID: dir,
          // When restoring a closed terminal (Cmd+Shift+T), pass the old PTY ID
          // via env since the generated SDK strips unknown body fields.
          // The server reads this to rename/restore disk history.
          ...(previousPtyId ? { previousPtyId } : {}),
        },
      }

      return fetch(`${claxedoBase}/api/claxedo/pty`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ptyBody),
      })
        .then((res) => res.json() as Promise<{ id: string; title: string; cwd?: string }>)
        .then((pty) => {
          pendingInitialCommand = undefined
          const id = pty.id
          if (!id) return undefined
          setStore("all", (all) => {
            const merged = mergeCreatedTerminal(all, { id, title: terminalTitle, cwd: pty.cwd })
            const idx = merged.findIndex((item) => item.id === id)
            if (idx === -1) return merged
            if (!initialCommand) return merged
            if (merged[idx].initialCommand) return merged
            return merged.map((item, i) => (i === idx ? { ...item, initialCommand } : item))
          })
          setStore("active", id)
          return id
        })
        .catch(() => {
          pendingInitialCommand = undefined
          return undefined
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
      })
      fetch(`${claxedoBase}/api/claxedo/pty/${pty.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: pty.title,
          size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
        }),
      }).catch(() => {})
    },
    async clone(id: string): Promise<string | undefined> {
      const index = store.all.findIndex((x) => x.id === id)
      const pty = store.all[index]
      if (!pty) return undefined
      const cwd = pty.cwd ?? sdk.directory
      const clone = await fetch(`${claxedoBase}/api/claxedo/pty`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: pty.title,
          cwd,
          env: {
            CLAXEDO_PORT: claxedoPort,
            CLAXEDO_WORKSPACE_ID: dir,
            previousPtyId: id,
          },
        }),
      })
        .then((res) => res.json() as Promise<{ id: string; title: string; cwd?: string }>)
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

      await fetch(`${claxedoBase}/api/claxedo/pty/${id}`, { method: "DELETE" }).catch(() => {})
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

const terminalContext = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const claxedoEvents = useClaxedoEventsOptional()
    const claxedoServerUrl = getClaxedoServerUrl()
    const terminalOptions: TerminalSessionOptions = { claxedoEvents, claxedoServerUrl }
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

    workspace = load(base64Encode(sdk.directory))
    lastWorkspace = workspace

    createEffect(() => {
      const next = load(base64Encode(sdk.directory))
      workspace = next
      lastWorkspace = next
    })

    createEffect(
      on(
        () => base64Encode(sdk.directory),
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
      trim: (id: string) => safeWorkspace()?.trim(id),
      trimAll: () => safeWorkspace()?.trimAll(),
    }
  },
})

export const useTerminal = terminalContext.use
export const TerminalProvider = terminalContext.provider

export function useOptionalTerminal() {
  return useContext(terminalContext.ctx)
}
