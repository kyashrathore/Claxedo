import { createContext, createRoot, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { machine } from "@/lib/machine"
import { useServer, type PlacementId, type Server, type ServerEvent, type SessionId, type Terminal, type TerminalId } from "@/server"
import type { Json } from "@/shell/types"
import { createRendererBudget, type RendererBudget } from "./backend/renderer-budget"
import { terminalsApi } from "./api"
import { asAppError, transitionLoad, type TerminalLoad, type TerminalLoadEvent, type TerminalRow } from "./model"
import { defaultTitleTemplates, t } from "./i18n"

export type OpenPane = (kind: string, state: Json, options?: { readonly paneId?: string }) => void

export type TerminalCreateOptions = {
  readonly title?: string
  readonly command?: string
  readonly sessionId?: SessionId
}

export type TerminalStore = {
  readonly placementId: PlacementId
  readonly load: Accessor<TerminalLoad>
  readonly rows: () => readonly TerminalRow[]
  readonly row: (terminalId: TerminalId) => TerminalRow | undefined
  readonly create: (options?: TerminalCreateOptions) => Promise<Terminal>
  readonly rename: (terminalId: TerminalId, title: string) => Promise<void>
  readonly close: (terminalId: TerminalId) => Promise<void>
  readonly recreate: (terminalId: TerminalId) => Promise<Terminal>
  readonly loadAgentStatus: (terminalId: TerminalId) => Promise<void>
}

const titlePatterns = defaultTitleTemplates.map((template) => {
  const [prefix = "", suffix = ""] = template.split("{{number}}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`^${prefix}(\\d+)${suffix}$`)
})

export function defaultTitleNumber(title: string): number | undefined {
  for (const pattern of titlePatterns) {
    const match = pattern.exec(title)
    if (!match) continue
    const number = Number(match[1])
    if (Number.isFinite(number) && number > 0) return number
  }
  return undefined
}

export function nextTerminalNumber(rows: readonly { title: string }[]): number {
  const taken = new Set(rows.map((row) => defaultTitleNumber(row.title)).filter((n): n is number => n !== undefined))
  let next = 1
  while (taken.has(next)) next += 1
  return next
}

export function createTerminalStore(server: Server, placementId: PlacementId): TerminalStore {
  const api = terminalsApi(server)
  const [state, setState] = createStore<{ rows: TerminalRow[] }>({ rows: [] })
  const load = machine<TerminalLoad, TerminalLoadEvent>({ kind: "idle" }, transitionLoad)
  const index = (terminalId: TerminalId) => state.rows.findIndex((row) => row.id === terminalId)

  const upsert = (terminal: Terminal) => {
    const at = index(terminal.id)
    if (at === -1) setState("rows", state.rows.length, terminal)
    else setState("rows", at, (row) => ({ ...row, ...terminal }))
  }
  const remove = (terminalId: TerminalId) => setState("rows", (rows) => rows.filter((row) => row.id !== terminalId))

  const apply = (event: ServerEvent) => {
    if (!("placementId" in event) && !("terminal" in event)) return
    if (event.type === "terminalCreated" || event.type === "terminalUpdated") {
      if (event.terminal.placementId === placementId) upsert(event.terminal)
      return
    }
    if (event.type === "terminalExited" || event.type === "terminalRemoved") {
      if (event.placementId === placementId) remove(event.terminalId)
      return
    }
    if (event.type === "terminalAgentStatusChanged" && event.placementId === placementId) {
      const at = index(event.terminalId)
      if (at !== -1) setState("rows", at, (row) => ({ ...row, agentStatus: event.status }))
    }
  }
  onCleanup(server.subscribe(apply))

  load.send({ type: "started" })
  api.list(placementId).then(
    (rows) => {
      for (const row of rows) upsert(row)
      load.send({ type: "loaded" })
    },
    (error: unknown) => load.send({ type: "failed", error: asAppError(error, t("terminal.loadFailed")) }),
  )

  const create = async (options: TerminalCreateOptions = {}) => {
    const number = nextTerminalNumber(state.rows)
    const title = options.title ? `${options.title} ${number}` : t("terminal.title.numbered", { number })
    const terminal = await api.create({ placementId, title, createRequestId: crypto.randomUUID(), ...options, ...(options.title ? { title } : {}) })
    upsert(terminal)
    return terminal
  }

  return {
    placementId,
    load: load.state,
    rows: () => state.rows,
    row: (terminalId) => state.rows.find((row) => row.id === terminalId),
    create,
    rename: async (terminalId, title) => {
      await api.update(placementId, terminalId, { title })
      const at = index(terminalId)
      if (at !== -1) setState("rows", at, (row) => ({ ...row, title }))
    },
    close: async (terminalId) => {
      remove(terminalId)
      await api.remove(placementId, terminalId)
    },
    recreate: async (terminalId) => {
      const previous = state.rows.find((row) => row.id === terminalId)
      const terminal = await api.create({
        placementId,
        title: previous?.title ?? t("terminal.title.numbered", { number: nextTerminalNumber(state.rows) }),
        createRequestId: crypto.randomUUID(),
        previousTerminalId: terminalId,
        ...(previous?.sessionId ? { sessionId: previous.sessionId } : {}),
      })
      remove(terminalId)
      upsert(terminal)
      return terminal
    },
    loadAgentStatus: async (terminalId) => {
      const status = await api.agentStatus(placementId, terminalId)
      const at = index(terminalId)
      if (at !== -1 && status) setState("rows", at, (row) => ({ ...row, agentStatus: status }))
    },
  }
}

export type TerminalContextValue = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly openPane: OpenPane
  readonly renderers: RendererBudget
  readonly store: (placementId: PlacementId) => TerminalStore
}

export const TerminalContext = createContext<TerminalContextValue>()

export function TerminalProvider(props: ParentProps<{ placementId: Accessor<PlacementId | undefined>; openPane: OpenPane }>) {
  const server = useServer()
  const stores = new Map<PlacementId, { store: TerminalStore; dispose: () => void }>()
  onCleanup(() => {
    for (const entry of stores.values()) entry.dispose()
    stores.clear()
  })
  const value: TerminalContextValue = {
    placementId: props.placementId,
    openPane: (kind, state, options) => props.openPane(kind, state, options),
    renderers: createRendererBudget(),
    store: (placementId) => {
      const existing = stores.get(placementId)
      if (existing) return existing.store
      const entry = createRoot((dispose) => ({ store: createTerminalStore(server, placementId), dispose }))
      stores.set(placementId, entry)
      return entry.store
    },
  }
  return <TerminalContext.Provider value={value}>{props.children}</TerminalContext.Provider>
}

export function useTerminalContext(): TerminalContextValue {
  const value = useContext(TerminalContext)
  if (!value) throw new Error("useTerminalContext needs a TerminalProvider above it")
  return value
}

export function useTerminals(placementId: PlacementId): TerminalStore {
  return useTerminalContext().store(placementId)
}
