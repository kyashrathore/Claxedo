import { readField } from "@claxedo/helpers/readers"
import { contractMismatch, ServerError, responseErrorCode } from "./errors"
import type { PlacementId, TerminalId } from "./ids"
import type { TerminalsApi } from "./api"
import type { Terminal, TerminalAgentId, TerminalAttachInput, TerminalCreateInput, TerminalPresence, TerminalStream } from "./terminal-types"
import { jsonInit, withQuery, type RuntimeRoute, type Transport } from "./transport"
import type { Workspaces } from "./workspaces"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import type { FetchQuery } from "./types"
import { agentStatusFromWire, PTY_AGENTS_PATH, PTY_NOT_FOUND, PTY_PATH, TERMINAL_HOOK_PATH, terminalAgentsFromWire, terminalFrameOf, terminalFromWire } from "./wire/terminals"

const PROTOCOL_ERROR_CLOSE = 1002

function attachSocket(socket: WebSocket, input: TerminalAttachInput): TerminalStream {
  const decoder = new TextDecoder()
  socket.binaryType = "arraybuffer"
  socket.onopen = () => input.onOpen()
  socket.onmessage = (event) => {
    const parsed = terminalFrameOf(event.data, decoder)
    if (!parsed.ok) {
      socket.close(PROTOCOL_ERROR_CLOSE, parsed.reason)
      return
    }
    if (parsed.frame) input.onFrame(parsed.frame)
  }
  socket.onclose = (event) => input.onClose({ code: event.code, reason: event.reason })
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(1000, "closed by the app"),
  }
}

function ptyPath(terminalId: TerminalId) {
  return `${PTY_PATH}/${encodeURIComponent(terminalId)}`
}

async function createPty(transport: Transport, where: RuntimeRoute, input: TerminalCreateInput): Promise<Terminal> {
  const body = {
    title: input.title,
    createRequestId: input.createRequestId,
    ...(input.command ? { initialCommand: input.command } : {}),
    env: {
      CLAXEDO_PORT: new URL(transport.serverUrl).port,
      CLAXEDO_WORKSPACE_ID: where.workspaceId,
      ...(input.previousTerminalId ? { previousPtyId: input.previousTerminalId } : {}),
    },
  }
  const created = terminalFromWire(await transport.runtimeJson(where, PTY_PATH, jsonInit("POST", body)), input.placementId)
  if (!created) throw new ServerError({ class: "internal", message: "The terminal create answered without a terminal" })
  return created
}

async function presenceOf(transport: Transport, where: RuntimeRoute, terminalId: TerminalId): Promise<TerminalPresence> {
  const response = await transport.runtime(where, ptyPath(terminalId)).catch((error: unknown) => {
    console.warn("Terminal presence could not be read", { terminalId, error })
    return undefined
  })
  if (!response) return "unreachable"
  if (response.ok) return "live"
  if (response.status !== 404) return "unreachable"
  return (await responseErrorCode(response)) === PTY_NOT_FOUND ? "gone" : "unreachable"
}

export function terminalQueries(transport: Transport, workspaces: Workspaces) {
  const agents = (placementId: PlacementId): FetchQuery<readonly TerminalAgentId[]> =>
    fetchQuery(queryKeys.terminalAgents(transport.serverUrl, placementId), async () => {
      const answer = terminalAgentsFromWire(await transport.runtimeJson(await workspaces.route(placementId), PTY_AGENTS_PATH))
      if (!answer) throw contractMismatch("terminal agents")
      return answer
    })
  return { agents }
}

export function createTerminalsApi(transport: Transport, workspaces: Workspaces): TerminalsApi {
  const route = (placementId: PlacementId) => workspaces.route(placementId)
  return {
    list: async (placementId) => {
      const rows = await transport.runtimeJson(await route(placementId), PTY_PATH)
      if (!Array.isArray(rows)) throw contractMismatch("terminal list")
      return rows.flatMap((row) => terminalFromWire(row, placementId) ?? [])
    },
    create: async (input) => createPty(transport, await route(input.placementId), input),
    update: async (placementId, terminalId, input) => {
      await transport.runtimeJson(await route(placementId), ptyPath(terminalId), jsonInit("PUT", input))
    },
    remove: async (placementId, terminalId) => {
      await transport.runtimeJson(await route(placementId), ptyPath(terminalId), { method: "DELETE" })
    },
    presence: async (placementId, terminalId) => presenceOf(transport, await route(placementId), terminalId),
    agentStatus: async (placementId, terminalId) => {
      const body = await transport.runtimeJson(await route(placementId), withQuery(TERMINAL_HOOK_PATH, { terminalId }))
      return agentStatusFromWire(readField(readField(body, "session"), "eventType"))
    },
    attach: async (input) => {
      const path = withQuery(`${ptyPath(input.terminalId)}/connect`, { cursor: input.cursor })
      return attachSocket(await transport.runtimeSocket(await route(input.placementId), path), input)
    },
  }
}
