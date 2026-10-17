import { machine } from "@/lib/machine"
import { hostContextChanges, type HostContext } from "./host-context"
import {
  rpcResult,
  inboundMessage,
  messageBytes,
  rpcError,
  rpcRequestId,
  responseMessage,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcParams,
  type OutboundMessage,
  type RequestAnswer,
} from "./jsonrpc"
import {
  bridgeTransition,
  clampAppHeight,
  DISPLAY_MODES,
  MAX_FRAME_MESSAGE_BYTES,
  MAX_REQUESTS_IN_FLIGHT,
  MCP_APPS_PROTOCOL_VERSION,
  TEARDOWN_WAIT_MS,
  type BridgePhase,
  type BridgeEvent,
  type DisplayMode,
} from "./model"
import type { AppNotification } from "./part"

export type FrameMessage = { readonly source: unknown; readonly data: unknown }

export type HostInfo = { readonly name: string; readonly version: string }

export type BridgeHost = {
  readonly hostContext: () => HostContext
  readonly hostCapabilities: () => JsonRpcParams
  readonly replay: () => readonly AppNotification[]
  readonly initialized: () => void
  readonly sizeChanged: (height: number) => void
  readonly openLink: (url: string) => RequestAnswer
  readonly requestDisplayMode: (mode: DisplayMode | undefined) => DisplayMode
  readonly callTool: (params: JsonRpcParams) => Promise<RequestAnswer>
  readonly readResource: (params: JsonRpcParams) => Promise<RequestAnswer>
  readonly message: (params: JsonRpcParams) => Promise<RequestAnswer>
  readonly log: (params: JsonRpcParams) => void
}

export type BridgeInput = {
  readonly frameWindow: () => unknown
  readonly post: (message: OutboundMessage) => void
  readonly host: BridgeHost
  readonly hostInfo: HostInfo
}

export type Bridge = {
  readonly receive: (message: FrameMessage) => void
  readonly contextChanged: () => void
  readonly teardown: () => Promise<void>
  readonly close: () => void
}

type RequestHandler = (params: JsonRpcParams) => RequestAnswer | Promise<RequestAnswer>

export function webLink(params: JsonRpcParams): string | undefined {
  const url = params.url
  if (typeof url !== "string" || !URL.canParse(url)) return undefined
  const parsed = new URL(url)
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : undefined
}

function displayModeOf(params: JsonRpcParams): DisplayMode | undefined {
  return DISPLAY_MODES.find((mode) => mode === params.mode)
}

function requestHandlers(host: BridgeHost): Readonly<Record<string, RequestHandler>> {
  return {
    "ui/open-link": (params) => {
      const url = webLink(params)
      return url ? host.openLink(url) : rpcError("ui/open-link opens http and https links only", RPC_INVALID_PARAMS)
    },
    "ui/request-display-mode": (params) => rpcResult({ mode: host.requestDisplayMode(displayModeOf(params)) }),
    "ui/message": host.message,
    "tools/call": host.callTool,
    "resources/read": host.readResource,
  }
}

class AppFrameBridge implements Bridge {
  private readonly phase = machine<BridgePhase, BridgeEvent>({ kind: "waiting" }, bridgeTransition)
  private readonly handlers: Readonly<Record<string, RequestHandler>>
  private readonly pending = new Map<JsonRpcId, () => void>()
  private sentContext: HostContext | undefined
  private inFlight = 0
  private nextId = 1

  constructor(private readonly input: BridgeInput) {
    this.handlers = requestHandlers(input.host)
  }

  receive(message: FrameMessage): void {
    if (this.isClosed() || message.source === null || message.source === undefined || message.source !== this.input.frameWindow()) return
    const bytes = messageBytes(message.data)
    if (bytes === undefined) return
    if (bytes > MAX_FRAME_MESSAGE_BYTES) return this.dropOversized(message.data, bytes)
    const inbound = inboundMessage(message.data)
    if (inbound?.kind === "request") this.request(inbound.id, inbound.method, inbound.params)
    else if (inbound?.kind === "notification") this.notification(inbound.method, inbound.params)
    else if (inbound?.kind === "response") this.pending.get(inbound.id)?.()
  }

  contextChanged(): void {
    if (this.phase.state().kind !== "open" || !this.sentContext) return
    const next = this.input.host.hostContext()
    const changes = hostContextChanges(this.sentContext, next)
    if (!changes) return
    this.sentContext = next
    this.notify("ui/notifications/host-context-changed", changes)
  }

  async teardown(): Promise<void> {
    if (this.phase.state().kind === "waiting" || this.isClosed()) return this.close()
    const id = `host-${this.nextId++}`
    const settled = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, TEARDOWN_WAIT_MS)
      this.pending.set(id, () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} })
    await settled
    this.close()
  }

  close(): void {
    this.phase.send({ type: "closed" })
    this.pending.clear()
  }

  private isClosed(): boolean {
    return this.phase.state().kind === "closed"
  }

  private post(message: OutboundMessage): void {
    if (this.isClosed()) return
    try {
      this.input.post(message)
    } catch (error) {
      console.warn("mcp-apps: a message to the app frame was not delivered", { error })
    }
  }

  private respond(id: JsonRpcId, answer: RequestAnswer): void {
    this.post(responseMessage(id, answer))
  }

  private notify(method: string, params: JsonRpcParams): void {
    this.post({ jsonrpc: "2.0", method, params })
  }

  private dropOversized(data: unknown, bytes: number): void {
    const id = rpcRequestId(data)
    console.warn("mcp-apps: dropped an app message over the size limit", { bytes })
    if (id !== undefined) this.respond(id, rpcError(`Messages are limited to ${MAX_FRAME_MESSAGE_BYTES} bytes`, RPC_INVALID_REQUEST))
  }

  private initialize(): RequestAnswer {
    if (this.phase.state().kind !== "waiting") return rpcError("The app is already initialized", RPC_INVALID_REQUEST)
    const hostContext = this.input.host.hostContext()
    this.sentContext = hostContext
    this.phase.send({ type: "initializeAnswered" })
    return rpcResult({ protocolVersion: MCP_APPS_PROTOCOL_VERSION, hostInfo: this.input.hostInfo, hostCapabilities: this.input.host.hostCapabilities(), hostContext })
  }

  private request(id: JsonRpcId, method: string, params: JsonRpcParams): void {
    if (method === "ui/initialize") return this.respond(id, this.initialize())
    if (method === "ping") return this.respond(id, rpcResult())
    if (this.phase.state().kind === "waiting") return this.respond(id, rpcError("Send ui/initialize first", RPC_INVALID_REQUEST))
    const handler = this.handlers[method]
    if (!handler) return this.respond(id, rpcError(`${method} is not offered by this host`, RPC_METHOD_NOT_FOUND))
    if (this.inFlight >= MAX_REQUESTS_IN_FLIGHT) return this.respond(id, rpcError(`More than ${MAX_REQUESTS_IN_FLIGHT} requests are in flight`))
    this.inFlight++
    void Promise.resolve()
      .then(() => handler(params))
      .then(
        (answer) => this.respond(id, answer),
        (error: unknown) => {
          console.error("mcp-apps: the host failed an app request", { method, error })
          this.respond(id, rpcError("The host could not answer", RPC_INTERNAL_ERROR))
        },
      )
      .finally(() => this.inFlight--)
  }

  private notification(method: string, params: JsonRpcParams): void {
    if (method === "ui/notifications/initialized") return this.initialized()
    if (method === "ui/notifications/size-changed" && typeof params.height === "number" && Number.isFinite(params.height)) {
      return this.input.host.sizeChanged(clampAppHeight(params.height))
    }
    if (method === "notifications/message") this.input.host.log(params)
  }

  private initialized(): void {
    if (this.phase.state().kind !== "initializing") return
    this.phase.send({ type: "initializedReceived" })
    this.input.host.initialized()
    for (const notification of this.input.host.replay()) this.notify(notification.method, notification.params)
    this.contextChanged()
  }
}

export function createBridge(input: BridgeInput): Bridge {
  return new AppFrameBridge(input)
}
