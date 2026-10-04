import {
  ClientSideConnection, PROTOCOL_VERSION,
  type Client, type InitializeResponse, type RequestPermissionRequest, type CreateElicitationRequest,
  type SessionNotification, type CompleteElicitationNotification,
} from "@agentclientprotocol/sdk"
import type { HarnessServices, OwnedProcess, StartInput } from "../../contract"
import { AcpTransportError } from "./errors"
import { AcpStartupDeadline } from "./deadline"
import { openAcpStream, retireAcpStream } from "./launch"
import type { AcpPeerOwnership } from "./ownership"
import { AcpRequestScope } from "./request-scope"
import { acpOrderedUpdates } from "./wire-updates"
import { singleFlightUntil } from "@claxedo/helpers"

export type AcpConnectionOptions = ({ startupTimeoutMs?: number; promptTimeoutMs?: number; sharedFilesystem?: boolean } & (
  | { kind: "process"; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; supportsMcpServers?: boolean }
  | { kind: "websocket"; url: string; headers?: Readonly<Record<string, string>>; protocols?: readonly string[]; supportsMcpServers?: boolean }
  | { kind: "streamable-http"; url: string; headers?: Readonly<Record<string, string>>; supportsMcpServers?: boolean }))

export type AcpHandlers = {
  permission(request: RequestPermissionRequest): ReturnType<Client["requestPermission"]>
  elicitation(request: CreateElicitationRequest): ReturnType<NonNullable<Client["createElicitation"]>>
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

export type AcpLaunch = { role: "harness" | "probe"; signal: AbortSignal; owner: AcpPeerOwnership }

export async function connectAcp(input: StartInput, options: AcpConnectionOptions, services: HarnessServices, handlers: AcpHandlers,
  launch: AcpLaunch): Promise<AcpPeer> {
  if ((options.kind === "process") !== (input.locality === "local")) {
    throw new AcpTransportError("configuration", "ACP connection kind does not match locality")
  }
  const { process, stream } = await openAcpStream(input, options, services, launch)
  const startup = new AcpStartupDeadline(services.clock, options.startupTimeoutMs, "initialize")
  let initializing = true
  const requests = new AcpRequestScope()
  const inbound = acpOrderedUpdates({ readable: stream.readable, writable: requests.writable(stream) }, handlers, requests)
  const agent = new ClientSideConnection(() => ({
    requestPermission: (request) => initializing ? startup.request(() => handlers.permission(request)) : handlers.permission(request),
    sessionUpdate: inbound.sessionUpdate,
    createElicitation: (request) => {
      requests.validate(request)
      return initializing ? startup.request(() => handlers.elicitation(request)) : handlers.elicitation(request)
    },
    completeElicitation: (notification) => handlers.complete(notification),
  }), inbound.stream)
  const retire = singleFlightUntil(() => retireAcpStream(process, inbound.cancel, services), () => true)
  launch.owner.own({ retire })
  try {
    const handshake = await startup.run(agent.initialize({ protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {}, url: {} }, session: { notices: {} } }, clientInfo: { name: "Claxedo", version: "2" } }), launch.signal)
    initializing = false
    return { agent, handshake, process, retire }
  } catch (error) {
    await launch.owner.retire({ retire })
    if (error instanceof AcpTransportError) throw error
    const exit = process ? await process.exited : undefined
    throw new AcpTransportError("connection", exit?.code !== null && exit?.code !== undefined
      ? `ACP initialization failed after process exited with code ${exit.code}` : "ACP initialization failed", error)
  }
}
