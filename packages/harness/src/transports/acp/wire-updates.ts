import type { AnyMessage, SessionNotification, Stream } from "@agentclientprotocol/sdk"
import type { AcpHandlers } from "./connection"
import type { AcpRequestScope } from "./request-scope"

type UpdateHandlers = Pick<AcpHandlers, "update" | "extension" | "unknown">

export type AcpOrderedUpdates = {
  stream: Stream
  cancel: (reason?: unknown) => Promise<void>
  sessionUpdate: (notification: SessionNotification) => Promise<void> | void
}

const CARRIED = "claxedo/carriedUpdate"

type Carried = { path: "extension" | "unknown"; update: unknown }

export function acpOrderedUpdates(stream: Stream, handlers: UpdateHandlers, requests: AcpRequestScope): AcpOrderedUpdates {
  const reader = stream.readable.getReader()
  let cancellation: Promise<void> | undefined
  const cancel = (reason?: unknown) => { cancellation ??= reader.cancel(reason); return cancellation }
  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      const item = await reader.read()
      if (item.done) { controller.close(); return }
      requests.settle(item.value)
      const wire = sessionUpdateWire(item.value)
      const path = wire && (subagentUpdate(wire.kind) ? "extension" : knownUpdate(wire.kind) ? undefined : "unknown")
      controller.enqueue(wire && path ? carriedMessage(wire, { path, update: wire.update }) : item.value)
    },
    cancel,
  })
  return { stream: { readable, writable: stream.writable }, cancel, sessionUpdate: (notification) => deliverInWireOrder(handlers, notification) }
}

function carriedMessage(wire: { sessionId: string }, carried: Carried): AnyMessage {
  return { jsonrpc: "2.0", method: "session/update",
    params: { sessionId: wire.sessionId, update: { sessionUpdate: "session_info_update" }, _meta: { [CARRIED]: carried } } }
}

function deliverInWireOrder(handlers: UpdateHandlers, notification: SessionNotification): Promise<void> | void {
  const carried = carriedUpdate(notification._meta?.[CARRIED])
  if (!carried) return handlers.update(notification)
  if (carried.path === "extension") return handlers.extension(notification.sessionId, carried.update)
  return handlers.unknown(notification.sessionId, "session/update", carried.update)
}

function carriedUpdate(value: unknown): Carried | undefined {
  if (!value || typeof value !== "object" || !("path" in value) || !("update" in value)) return undefined
  if (value.path !== "extension" && value.path !== "unknown") return undefined
  return { path: value.path, update: value.update }
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
