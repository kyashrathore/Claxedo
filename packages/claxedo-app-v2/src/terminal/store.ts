import { onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { machine, type Machine } from "@/lib/machine"
import { uuid } from "@/lib/uuid"
import {
  toAppError,
  type PlacementId,
  type Server,
  type ServerEvent,
  type Terminal,
  type TerminalAgentStatus,
  type TerminalId,
  type TerminalsApi,
} from "@/server"
import { terminalsApi } from "./api"
import { transitionLoad, type TerminalLoad, type TerminalLoadEvent, type TerminalRow } from "./model"
import { launcherTitle, nextTerminalNumber } from "./titles"

export type TerminalStore = {
  readonly placementId: PlacementId
  readonly load: Accessor<TerminalLoad>
  readonly rows: () => readonly TerminalRow[]
  readonly row: (terminalId: TerminalId) => TerminalRow | undefined
  readonly create: (launch?: TerminalLaunch) => Promise<Terminal>
  readonly recreate: (terminalId: TerminalId) => Promise<Terminal>
  readonly close: (terminalId: TerminalId) => Promise<void>
  readonly loadAgentStatus: (terminalId: TerminalId) => Promise<void>
}

export type TerminalLaunch = { readonly command?: string; readonly title?: string }

export type TerminalStoreInput = {
  readonly server: Server
  readonly placementId: PlacementId
  readonly numberedTitle: (number: number) => string
}

type TerminalRows = ReturnType<typeof createTerminalRows>

function createTerminalRows() {
  const [state, setState] = createStore<{ rows: TerminalRow[] }>({ rows: [] })
  const index = (terminalId: TerminalId) => state.rows.findIndex((row) => row.id === terminalId)
  return {
    all: () => state.rows,
    find: (terminalId: TerminalId) => state.rows.find((row) => row.id === terminalId),
    upsert: (terminal: Terminal) => {
      const at = index(terminal.id)
      if (at === -1) setState("rows", state.rows.length, terminal)
      else setState("rows", at, (row) => ({ ...row, ...terminal }))
    },
    remove: (terminalId: TerminalId) => setState("rows", (rows) => rows.filter((row) => row.id !== terminalId)),
    setAgentStatus: (terminalId: TerminalId, agentStatus: TerminalAgentStatus) => {
      const at = index(terminalId)
      if (at !== -1) setState("rows", at, (row) => ({ ...row, agentStatus }))
    },
  }
}

function applyTerminalEvent(rows: TerminalRows, placementId: PlacementId, event: ServerEvent): void {
  if (event.type === "terminalCreated" || event.type === "terminalUpdated") {
    if (event.terminal.placementId === placementId) rows.upsert(event.terminal)
    return
  }
  if (event.type === "terminalExited" || event.type === "terminalRemoved") {
    if (event.placementId === placementId) rows.remove(event.terminalId)
    return
  }
  if (event.type === "terminalAgentStatusChanged" && event.placementId === placementId)
    rows.setAgentStatus(event.terminalId, event.status)
}

function loadTerminalList(
  api: TerminalsApi,
  placementId: PlacementId,
  rows: TerminalRows,
  load: Machine<TerminalLoad, TerminalLoadEvent>,
): void {
  load.send({ type: "started" })
  api.list(placementId).then(
    (list) => {
      for (const row of list) rows.upsert(row)
      load.send({ type: "loaded" })
    },
    (error: unknown) => {
      const failure = toAppError(error)
      console.error("Terminal list failed to load", { placementId, error: failure })
      load.send({ type: "failed", error: failure })
    },
  )
}

type TerminalActionsInput = {
  readonly api: TerminalsApi
  readonly placementId: PlacementId
  readonly rows: TerminalRows
  readonly numberedTitle: () => string
}

async function recreateTerminal(input: TerminalActionsInput, terminalId: TerminalId): Promise<Terminal> {
  const previous = input.rows.find(terminalId)
  const sessionId = previous?.sessionId
  const terminal = await input.api.create({
    placementId: input.placementId,
    title: previous?.title ?? input.numberedTitle(),
    createRequestId: uuid(),
    previousTerminalId: terminalId,
    ...(sessionId ? { sessionId } : {}),
  })
  input.rows.remove(terminalId)
  input.rows.upsert(terminal)
  return terminal
}

export function createTerminalStore(input: TerminalStoreInput): TerminalStore {
  const { server, placementId } = input
  const api = terminalsApi(server)
  const rows = createTerminalRows()
  const load = machine<TerminalLoad, TerminalLoadEvent>({ kind: "idle" }, transitionLoad)
  onCleanup(server.subscribe((event) => applyTerminalEvent(rows, placementId, event)))
  loadTerminalList(api, placementId, rows, load)
  const numberedTitle = () => input.numberedTitle(nextTerminalNumber(rows.all()))
  const actions: TerminalActionsInput = { api, placementId, rows, numberedTitle }
  return {
    placementId,
    load: load.state,
    rows: rows.all,
    row: rows.find,
    create: async (launch) => {
      const title = launch?.title ? launcherTitle(launch.title, rows.all()) : numberedTitle()
      const command = launch?.command ? { command: launch.command } : {}
      const terminal = await api.create({ placementId, title, createRequestId: uuid(), ...command })
      rows.upsert(terminal)
      return terminal
    },
    recreate: (terminalId) => recreateTerminal(actions, terminalId),
    close: async (terminalId) => {
      await api.remove(placementId, terminalId)
      rows.remove(terminalId)
    },
    loadAgentStatus: async (terminalId) => {
      const status = await api.agentStatus(placementId, terminalId)
      if (status) rows.setAgentStatus(terminalId, status)
    },
  }
}
