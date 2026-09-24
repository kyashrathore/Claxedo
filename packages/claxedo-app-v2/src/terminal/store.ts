import { onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { machine } from "@/lib/machine"
import { uuid } from "@/lib/uuid"
import type { PlacementId, Server, ServerEvent, Terminal, TerminalId } from "@/server"
import { terminalsApi } from "./api"
import { asAppError, transitionLoad, type TerminalLoad, type TerminalLoadEvent, type TerminalRow } from "./model"
import { nextTerminalNumber } from "./titles"

export type TerminalStore = {
  readonly placementId: PlacementId
  readonly load: Accessor<TerminalLoad>
  readonly rows: () => readonly TerminalRow[]
  readonly row: (terminalId: TerminalId) => TerminalRow | undefined
  readonly create: () => Promise<Terminal>
  readonly recreate: (terminalId: TerminalId) => Promise<Terminal>
  readonly loadAgentStatus: (terminalId: TerminalId) => Promise<void>
}

export type TerminalStoreInput = {
  readonly server: Server
  readonly placementId: PlacementId
  readonly numberedTitle: (number: number) => string
}

export function createTerminalStore(input: TerminalStoreInput): TerminalStore {
  const { server, placementId } = input
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
    (error: unknown) => {
      const failure = asAppError(error, "Terminal list failed to load")
      console.error("Terminal list failed to load", { placementId, error: failure })
      load.send({ type: "failed", error: failure })
    },
  )

  return {
    placementId,
    load: load.state,
    rows: () => state.rows,
    row: (terminalId) => state.rows.find((row) => row.id === terminalId),
    create: async () => {
      const title = input.numberedTitle(nextTerminalNumber(state.rows))
      const terminal = await api.create({ placementId, title, createRequestId: uuid() })
      upsert(terminal)
      return terminal
    },
    recreate: async (terminalId) => {
      const previous = state.rows.find((row) => row.id === terminalId)
      const terminal = await api.create({
        placementId,
        title: previous?.title ?? input.numberedTitle(nextTerminalNumber(state.rows)),
        createRequestId: uuid(),
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
