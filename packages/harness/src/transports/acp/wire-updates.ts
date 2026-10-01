import type { AnyMessage, SessionNotification, Stream } from "@agentclientprotocol/sdk"
import { asRecord } from "@claxedo/helpers/guards"
import type { AcpHandlers } from "./connection"
import type { AcpRequestScope } from "./request-scope"
import { isAdvertisedUpdate } from "./translate/translate-session-update"

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
      const path = wire && (subagentUpdate(wire.kind) ? "extension" : isAdvertisedUpdate(wire.kind) ? undefined : "unknown")
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
  const row = asRecord(value)
  if (!row || !("update" in row) || (row.path !== "extension" && row.path !== "unknown")) return undefined
  return { path: row.path, update: row.update }
}

function subagentUpdate(type: string): boolean {
  return type === "subagent_spawned" || type === "subagent_state_update"
}

function sessionUpdateWire(message: unknown): { sessionId: string; kind: string; update: unknown } | undefined {
  const row = asRecord(message)
  const params = row?.method === "session/update" ? asRecord(row.params) : undefined
  const update = asRecord(params?.update)
  if (typeof params?.sessionId !== "string" || typeof update?.sessionUpdate !== "string") return undefined
  return { sessionId: params.sessionId, kind: update.sessionUpdate, update }
}
