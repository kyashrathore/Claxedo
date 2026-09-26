import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
  type Client, type InitializeResponse, type RequestPermissionRequest, type CreateElicitationRequest,
  type SessionNotification, type CompleteElicitationNotification, type Stream,
} from "@agentclientprotocol/sdk"
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client"
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client"
import type { HarnessServices, OwnedProcess, StartInput } from "../../contract"
import { AcpTransportError } from "./errors"
import { AcpStartupDeadline } from "./deadline"
import { processByteStreams } from "./streams"
import { stringRecord } from "@claxedo/helpers"

export type AcpConnectionOptions = ({ startupTimeoutMs?: number; promptTimeoutMs?: number } & (
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
  const { process, stream } = await openStream(input, options, services, launch)
  const startup = new AcpStartupDeadline(services.clock, options.startupTimeoutMs ?? 10_000, "initialize")
  let initializing = true
  const inbound = extensionStream(stream, handlers)
  const agent = new ClientSideConnection(() => ({
    requestPermission: (request) => initializing ? startup.request(() => handlers.permission(request)) : handlers.permission(request),
    sessionUpdate: (notification) => handlers.update(notification),
    unstable_createElicitation: (request) => initializing ? startup.request(() => handlers.elicitation(request)) : handlers.elicitation(request),
    unstable_completeElicitation: (notification) => handlers.complete(notification),
  }), inbound.stream)
  let retirement: Promise<void> | undefined
  const retire = () => { retirement ??= retireStream(process, inbound.cancel, services); return retirement }
  try {
    const handshake = await startup.run(agent.initialize({ protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: "Claxedo", version: "2" } }))
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

function extensionStream(stream: Stream, handlers: AcpHandlers): { stream: Stream; cancel: (reason?: unknown) => Promise<void> } {
  const reader = stream.readable.getReader()
  let cancellation: Promise<void> | undefined
  const cancel = (reason?: unknown) => { cancellation ??= reader.cancel(reason); return cancellation }
  const readable = new ReadableStream<StreamMessage>({
    async pull(controller) {
      while (true) {
        const item = await reader.read()
        if (item.done) { controller.close(); return }
        const extension = subagentWire(item.value)
        if (extension) { await handlers.extension(extension.sessionId, extension.update); continue }
        const unknown = unrecognizedWire(item.value)
        if (unknown) { await handlers.unknown(unknown.sessionId, "session/update", unknown.update); continue }
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

function unrecognizedWire(message: unknown): { sessionId: string; update: unknown } | undefined {
  if (!message || typeof message !== "object" || !("method" in message) || message.method !== "session/update" ||
    !("params" in message)) return undefined
  const params = message.params
  if (!params || typeof params !== "object" || !("sessionId" in params) || typeof params.sessionId !== "string" ||
    !("update" in params)) return undefined
  const update = params.update
  if (!update || typeof update !== "object" || !("sessionUpdate" in update) ||
    typeof update.sessionUpdate !== "string" || knownUpdate(update.sessionUpdate) ||
    update.sessionUpdate === "subagent_spawned" || update.sessionUpdate === "subagent_state_update") return undefined
  return { sessionId: params.sessionId, update }
}

type StreamMessage = Stream["readable"] extends ReadableStream<infer Message> ? Message : never

function subagentWire(message: unknown): { sessionId: string; update: unknown } | undefined {
  if (!message || typeof message !== "object" || !("method" in message) || message.method !== "session/update" ||
    !("params" in message)) return undefined
  const params = message.params
  if (!params || typeof params !== "object" || !("sessionId" in params) || typeof params.sessionId !== "string" ||
    !("update" in params)) return undefined
  const update = params.update
  if (!update || typeof update !== "object" || !("sessionUpdate" in update) ||
    (update.sessionUpdate !== "subagent_spawned" && update.sessionUpdate !== "subagent_state_update")) return undefined
  return { sessionId: params.sessionId, update }
}

async function openStream(input: StartInput, options: AcpConnectionOptions, services: HarnessServices,
  launch: AcpLaunch): Promise<{ process?: OwnedProcess; stream: Stream }> {
  if (options.kind === "process") {
    const process = await services.spawn({ file: options.command, args: options.args ?? [], cwd: input.directory,
      env: { ...processEnv(), ...options.env, ...input.credentials.secrets } },
      { role: launch.role, label: "ACP", sessionId: input.sessionId, signal: launch.signal })
    const streams = processByteStreams(process)
    const stream = ndJsonStream(streams.output, streams.input)
    return { process, stream }
  }
  if (options.kind === "websocket") return { stream: createWebSocketStream(options.url,
    { headers: options.headers, protocols: options.protocols ? [...options.protocols] : undefined }) }
  return { stream: createHttpStream(options.url, { headers: options.headers }) }
}

async function retireStream(process: OwnedProcess | undefined,
  cancel: (reason?: unknown) => Promise<void>, services: HarnessServices): Promise<void> {
  if (!process) { await cancel(); return }
  const result = await process.retire({ at: services.clock.now() + 5_000, signal: new AbortController().signal })
  if (!result.stopped) throw new AcpTransportError("ownership", result.error.message)
}

function processEnv(): Record<string, string> {
  return stringRecord(process.env)
}
