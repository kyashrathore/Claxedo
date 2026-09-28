import type { StartInput, TurnInput, RoutedEvent } from "../../contract"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../../broker"
import { MemoryPorts, authority, origin } from "./memory-ports"
import { createTestServices } from "./services"
import { pollUntil } from "./poll"
import { filterMcpServers } from "../../capabilities/mcp-filter"
import { AcpTransport } from "../../transports/acp"
import { ScriptedProcess } from "../../test-support/scripted-process"

export type Wire = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }
export const catalog = [{ id: "model", category: "model", name: "Model", type: "select", currentValue: "one",
  options: [{ value: "one", name: "One" }, { value: "two", name: "Two" }] }]

export class WirePeer extends ScriptedProcess<Wire> {
  readonly messages = this.received
  constructor(readonly number: number, handle: (peer: WirePeer, message: Wire) => boolean | void) {
    super((message, process) => {
      const peer = process as WirePeer
      if (handle(peer, message) || message.id === undefined || !message.method) return
      if (message.method === "initialize") peer.reply(message, { protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} }, _meta: { health: true } } })
      else if (message.method === "session/new") peer.reply(message, { sessionId: `up-${number}`, configOptions: catalog })
      else if (message.method === "session/resume") peer.reply(message, { configOptions: catalog })
      else if (message.method === "session/set_config_option") peer.reply(message, {
        configOptions: catalog.map((option) => ({ ...option, currentValue: message.params?.value })) })
      else if (message.method === "session/prompt") peer.reply(message, { stopReason: "end_turn" })
      else peer.reply(message, {})
    })
  }
  reply(message: Wire, result: unknown) { this.send({ jsonrpc: "2.0", id: message.id, result }) }
  fail(message: Wire, code: number, messageText: string) { this.send({ jsonrpc: "2.0", id: message.id, error: { code, message: messageText } }) }
  elicit(id: string, owner: { requestId: number | string } | { sessionId: string }) {
    this.send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { ...owner, mode: "form", message: "Choose",
      requestedSchema: { type: "object", properties: { answer: { type: "string", pattern: "^yes$" } }, required: ["answer"] } } })
  }
  text(sessionId: string, text: string) {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } })
  }
}

export function wireFixture(handle: (peer: WirePeer, message: Wire) => boolean | void = () => false,
  options: { startupTimeoutMs?: number; promptTimeoutMs?: number } = {}) {
  const services = createTestServices()
  const peers: WirePeer[] = []
  services.spawn = async () => {
    const peer = new WirePeer(peers.length + 1, handle)
    peers.push(peer)
    const process = peer.owned()
    services.processes.push(process)
    return process
  }
  const ports = new MemoryPorts()
  const owner = createRequestBroker(ports)
  const binding = { sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "c1", operationId: "start-1" }
  ports.startBinding = binding
  const sessionBroker = createSessionBroker(owner, { ...binding, start: binding, origin })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local", owner: origin.actor,
    config: { harness: { id: "c1", access: "connection" }, model: { providerID: "c1", modelID: "one" } },
    model: { providerID: "c1", modelID: "one" }, credentials: { providers: {}, leaseGeneration: "g1", secrets: {} },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  const transport = new AcpTransport(services, { kind: "process", command: "wire-peer", ...options }, filterMcpServers,
    async () => { throw new Error("No missing-session handoff expected") })
  const turn: TurnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin, model: input.model,
    prompt: { agent: "build", assistantMessageId: "a1", parts: [{ type: "text", text: "hello" }] }, todos: [] }
  const turnBroker = (signal = new AbortController().signal) => createTurnBroker(owner,
    { authority: ports.current.get("s1") ?? authority, origin, signal })
  const start = async () => { const session = await transport.start(input, sessionBroker); ports.startStatus = "created"; return session }
  return { services, peers, ports, owner, binding, input, transport, sessionBroker, turnBroker, turn, start }
}

export async function reached<T>(read: () => T | undefined): Promise<T> {
  const value = await pollUntil(read, Date.now() + 1_000)
  if (value === undefined) throw new Error("Expected wire boundary was not reached")
  return value
}

export async function collect(stream: AsyncIterable<RoutedEvent>) {
  const events: RoutedEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
