import {
  ClientSideConnection, PROTOCOL_VERSION,
  type AnyMessage, type Client, type InitializeResponse, type RequestPermissionRequest, type CreateElicitationRequest,
  type SessionNotification, type CompleteElicitationNotification, type Stream,
} from "@agentclientprotocol/sdk"
import type { HarnessServices, OwnedProcess, StartInput } from "../../contract"
import { AcpTransportError } from "./errors"
import { AcpStartupDeadline } from "./deadline"
import { openAcpStream, retireAcpStream } from "./launch"
import { AcpRequestScope } from "./request-scope"
import { singleFlightUntil } from "@claxedo/helpers"

export type AcpConnectionOptions = ({ startupTimeoutMs?: number; promptTimeoutMs?: number; sharedFilesystem?: boolean } & (
  | { kind: "process"; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; supportsMcpServers?: boolean }
  | { kind: "websocket"; url: string; headers?: Readonly<Record<string, string>>; protocols?: readonly string[]; supportsMcpServers?: boolean }
  | { kind: "streamable-http"; url: string; headers?: Readonly<Record<string, string>>; supportsMcpServers?: boolean }))

export type AcpHandlers = {
  permission(request: RequestPermissionRequest): ReturnType<Client["requestPermission"]>
  elicitation(request: CreateElicitationRequest): ReturnType<NonNullable<Client["unstable_createElicitation"]>>
  complete(notification: CompleteElicitationNotification): Promise<void> | void
  update(notification: SessionNotification): Promise<void> | void
  extension(sessionId: string, update: unknown): Promise<void> | void
  unknown(sessionId: string, method: string, payload: unknown): Promise<void> | void
}

export type AcpPeer = {
  agent: ClientSideConnection
  handshake: InitializeResponse
  process?: OwnedProcess
  retire(): Promise<void>
}

export type AcpLaunch = { role: "harness" | "probe"; signal: AbortSignal }

export async function connectAcp(input: StartInput, options: AcpConnectionOptions, services: HarnessServices, handlers: AcpHandlers,
  launch: AcpLaunch): Promise<AcpPeer> {
  if ((options.kind === "process") !== (input.locality === "local")) {
    throw new AcpTransportError("configuration", "ACP connection kind does not match locality")
  }
  const { process, stream } = await openAcpStream(input, options, services, launch)
  const startup = new AcpStartupDeadline(services.clock, options.startupTimeoutMs ?? 10_000, "initialize")
  let initializing = true
  const requests = new AcpRequestScope()
  const inbound = extensionStream({ readable: stream.readable, writable: requests.writable(stream) }, handlers, requests)
  const agent = new ClientSideConnection(() => ({
    requestPermission: (request) => initializing ? startup.request(() => handlers.permission(request)) : handlers.permission(request),
    sessionUpdate: (notification) => handlers.update(notification),
    unstable_createElicitation: (request) => {
      requests.validate(request)
      return initializing ? startup.request(() => handlers.elicitation(request)) : handlers.elicitation(request)
    },
    unstable_completeElicitation: (notification) => handlers.complete(notification),
  }), inbound.stream)
  const retire = singleFlightUntil(() => retireAcpStream(process, inbound.cancel, services), () => true)
  try {
    const handshake = await startup.run(agent.initialize({ protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: "Claxedo", version: "2" } }), launch.signal)
    initializing = false
    return { agent, handshake, process, retire }
  } catch (error) {
    await retire()
    if (error instanceof AcpTransportError) throw error
    const exit = process ? await process.exited : undefined
    throw new AcpTransportError("connection", exit?.code !== null && exit?.code !== undefined
      ? `ACP initialization failed after process exited with code ${exit.code}` : "ACP initialization failed", error)
  }
}

function extensionStream(stream: Stream, handlers: AcpHandlers, requests: AcpRequestScope): { stream: Stream; cancel: (reason?: unknown) => Promise<void> } {
  const reader = stream.readable.getReader()
  let cancellation: Promise<void> | undefined
  const cancel = (reason?: unknown) => { cancellation ??= reader.cancel(reason); return cancellation }
  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      while (true) {
        const item = await reader.read()
        if (item.done) { controller.close(); return }
        requests.settle(item.value)
        const wire = sessionUpdateWire(item.value)
        if (wire && subagentUpdate(wire.kind)) { await handlers.extension(wire.sessionId, wire.update); continue }
        if (wire && !knownUpdate(wire.kind)) { await handlers.unknown(wire.sessionId, "session/update", wire.update); continue }
        controller.enqueue(item.value)
        return
      }
    },
    cancel,
  })
  return { stream: { readable, writable: stream.writable }, cancel }
}

function knownUpdate(type: string): boolean {
  switch (type) {
    case "agent_message_chunk": case "agent_thought_chunk": case "user_message_chunk": case "tool_call":
    case "tool_call_update": case "plan": case "plan_update": case "plan_removed":
    case "available_commands_update": case "current_mode_update": case "config_option_update":
    case "session_info_update": case "usage_update": return true
    default: return false
  }
}

function subagentUpdate(type: string): boolean {
  return type === "subagent_spawned" || type === "subagent_state_update"
}

function sessionUpdateWire(message: unknown): { sessionId: string; kind: string; update: unknown } | undefined {
  if (!message || typeof message !== "object" || !("method" in message) || message.method !== "session/update" ||
    !("params" in message)) return undefined
  const params = message.params
  if (!params || typeof params !== "object" || !("sessionId" in params) || typeof params.sessionId !== "string" ||
    !("update" in params)) return undefined
  const update = params.update
  if (!update || typeof update !== "object" || !("sessionUpdate" in update) || typeof update.sessionUpdate !== "string") return undefined
  return { sessionId: params.sessionId, kind: update.sessionUpdate, update }
}
