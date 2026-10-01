import { asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent, RawHarnessEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapterContext, HarnessEventAdapterResult } from "../../../translate/adapter"
import type { ServerNotification, ServerRequest } from "./protocol"
import type { CodexAppServerAdapterState } from "./state"

type CodexAppServerProtocolEvent = ServerNotification | ServerRequest

export type CodexMethod = CodexAppServerProtocolEvent["method"]

export type CodexThreadModel = (threadId: string) => string | undefined

export type CodexFrame = {
  state: CodexAppServerAdapterState
  event: RawHarnessEvent
  context: HarnessEventAdapterContext
  method: CodexMethod
  row: Record<string, unknown>
  requestId?: string
  threadModel?: CodexThreadModel
}

export type CodexHandler = (frame: CodexFrame) => HarnessEventAdapterResult<CodexAppServerAdapterState> | AgentRuntimeEvent[]

export type CodexHandlers = Partial<Record<CodexMethod, CodexHandler>>

export function eventPayload(event: { payload: unknown }) {
  return asRecord(event.payload) ?? {}
}

export function eventText(event: { payload: unknown }) {
  const row = eventPayload(event)
  return text(row.delta) ?? text(row.text)
}

export function item(event: { payload: unknown }) {
  return asRecord(eventPayload(event).item)
}

export function itemId(event: { payload: unknown }, fallback: string) {
  return text(eventPayload(event).itemId) ?? text(item(event)?.id) ?? fallback
}

export function threadOf(event: { payload: unknown }, context: HarnessEventAdapterContext) {
  return text(eventPayload(event).threadId) ?? context.threadId
}

export function codexSessionId(event: { payload: unknown }, context: HarnessEventAdapterContext) {
  return text(eventPayload(event).sessionId) ?? threadOf(event, context)
}

export function frameRequestId(event: { payload: unknown }) {
  return text(eventPayload(event).requestId)
}

export function protocolMethod(event: { method?: string }): CodexMethod {
  if (!event.method) throw new Error("Codex app-server event is missing a method")
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return event.method as CodexMethod
}
