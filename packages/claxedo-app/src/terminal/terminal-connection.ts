import { authFetch } from "@/shared/data/api"
import { createWorkspaceRelayConnection, openWorkspaceConnection } from "@/agent-runtime/workspace-relay-connection"

export class WebSocketCloseError extends Error {
  public readonly code: number
  public readonly reason: string

  constructor(code: number, reason: string) {
    super(`WebSocket closed: ${code} ${reason}`)
    this.code = code
    this.reason = reason
    this.name = "WebSocketCloseError"
  }
}

export function socketCloseIsError(code: number) {
  return code !== 1000
}

export function sigwinchToggleSize(cols: number, rows: number) {
  const safeCols = Math.max(2, cols)
  return [
    { cols: Math.max(2, safeCols - 1), rows },
    { cols: safeCols, rows },
  ]
}

/**
 * Whether a WebSocket close code represents a transient failure worth retrying.
 * Returns false for permanent/intentional closures (normal, session gone, overload).
 */
export function isRetriableClose(code: number): boolean {
  if (code === 1000 || code === 1008 || code === 4000) return false
  return true
}

/** Exponential backoff delay: 1s, 2s, 4s, 8s, 16s (cap). */
export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 16000)
}

/** Maximum reconnect attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 6

/** ANSI status message shown in terminal during reconnection. */
export function reconnectingMessage(attempt: number, maxAttempts: number): string {
  return `\r\n\x1b[2;3m[Reconnecting... attempt ${attempt}/${maxAttempts}]\x1b[0m\r\n`
}

/** ANSI status message shown in terminal after successful reconnection. */
export function reconnectedMessage(): string {
  return `\x1b[2;3m[Reconnected]\x1b[0m\r\n`
}

/** ANSI status message shown in terminal when all reconnect attempts are exhausted. */
export function reconnectFailedMessage(): string {
  return `\r\n\x1b[31;1m[Connection lost. Terminal will recover when server restarts.]\x1b[0m\r\n`
}

type WebSocketCtor = typeof WebSocket

const terminalPtyRoutePath = "/api/wr/pty"

function terminalPtyPath(input: { path: string; workspaceId?: string; directory?: string }) {
  const url = new URL(input.path, "http://claxedo.local")
  if (input.workspaceId) url.searchParams.set("workspaceId", input.workspaceId)
  if (input.directory) url.searchParams.set("directory", input.directory)
  return `${url.pathname}${url.search}`
}

export function terminalPtyApiPath(input?: { suffix?: string; workspaceId?: string; directory?: string }) {
  const suffix = input?.suffix
    ? input.suffix.startsWith("/") ? input.suffix : `/${input.suffix}`
    : ""
  return terminalPtyPath({
    path: `${terminalPtyRoutePath}${suffix}`,
    workspaceId: input?.workspaceId,
    directory: input?.directory,
  })
}

function terminalWebSocketUrl(input: { serverUrl: string; path: string; locationProtocol?: string }) {
  const url = new URL(`${input.serverUrl}${input.path}`)
  if (url.protocol === "http:") url.protocol = "ws:"
  if (url.protocol === "https:") url.protocol = "wss:"
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    url.protocol = input.locationProtocol === "https:" ? "wss:" : "ws:"
  }
  return url
}

async function openWorkspaceRelay(input: {
  serverUrl: string
  workspaceId: string
  request?: typeof fetch
  relayRequest?: typeof fetch
  webSocket?: WebSocketCtor
}) {
  return createWorkspaceRelayConnection(
    await openWorkspaceConnection(input.workspaceId, {
      serverUrl: input.serverUrl,
      request: input.request,
      webSocket: input.webSocket,
    }),
    {
      serverUrl: input.serverUrl,
      request: input.request,
      relayRequest: input.relayRequest ?? input.request,
      webSocket: input.webSocket,
    },
  )
}

export function createTerminalPtyClient(input: {
  serverUrl: string
  workspaceId?: string
  directory?: string
  request?: typeof fetch
  relayRequest?: typeof fetch
  webSocket?: WebSocketCtor
}) {
  const request = input.request ?? authFetch
  let relay: Awaited<ReturnType<typeof openWorkspaceRelay>> | undefined

  const runtime = async () => {
    if (!input.workspaceId) return undefined
    // Terminal owners pass an explicit workspaceId after resolving placement;
    // the shared runtime placement decision lives in resolveRuntimeTarget.
    relay ??= await openWorkspaceRelay({
      serverUrl: input.serverUrl,
      workspaceId: input.workspaceId,
      request,
      relayRequest: input.relayRequest,
      webSocket: input.webSocket,
    })
    return relay
  }

  const ptyFetch = async (path: string, init: RequestInit) => {
    const apiPath = terminalPtyApiPath({
      suffix: path,
      workspaceId: input.workspaceId,
      directory: input.directory,
    })
    const relayRuntime = await runtime()
    if (relayRuntime) return relayRuntime.fetch(apiPath, init)
    return request(`${input.serverUrl}${apiPath}`, init)
  }

  return {
    update: (ptyId: string, body: unknown) =>
      ptyFetch(`/${encodeURIComponent(ptyId)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
  }
}

export async function openTerminalWebSocket(input: {
  serverUrl: string
  ptyId: string
  cursor: number
  workspaceId?: string
  directory?: string
  request?: typeof fetch
  relayRequest?: typeof fetch
  webSocket?: WebSocketCtor
  locationProtocol?: string
}) {
  const path = terminalPtyApiPath({
    suffix: `/${encodeURIComponent(input.ptyId)}/connect?cursor=${encodeURIComponent(String(input.cursor))}`,
    workspaceId: input.workspaceId,
    directory: input.directory,
  })

  if (input.workspaceId) {
    // Terminal owners pass an explicit workspaceId after resolving placement;
    // the shared runtime placement decision lives in resolveRuntimeTarget.
    return await (await openWorkspaceRelay({
      serverUrl: input.serverUrl,
      workspaceId: input.workspaceId,
      request: input.request,
      relayRequest: input.relayRequest,
      webSocket: input.webSocket,
    })).webSocket(path)
  }

  return new (input.webSocket ?? WebSocket)(terminalWebSocketUrl({
    serverUrl: input.serverUrl,
    path,
    locationProtocol: input.locationProtocol,
  }))
}
