import type { HarnessEventAdapter } from "../../../translate/adapter"
import { accountHandlers } from "./account"
import { eventPayload, protocolMethod, type CodexHandlers } from "./frame"
import { hookHandlers } from "./hooks"
import { itemHandlers } from "./item-lifecycle"
import { messageHandlers } from "./message-items"
import { noticeHandlers, unmappedCodexAppServerEvent } from "./notices"
import { usageHandlers } from "./reported-model"
import { createCodexAppServerAdapterState, type CodexAppServerAdapterState } from "./state"
import { toolStreamHandlers } from "./tool-stream"
import { turnHandlers } from "./turn-lifecycle"

const handlers: CodexHandlers = {
  ...messageHandlers,
  ...itemHandlers,
  ...toolStreamHandlers,
  ...turnHandlers,
  ...usageHandlers,
  ...accountHandlers,
  ...noticeHandlers,
  ...hookHandlers,
}

export function codexAppServerAdapter(): HarnessEventAdapter<CodexAppServerAdapterState> {
  return {
    name: "codex-app-server",
    createInitialState: createCodexAppServerAdapterState,
    translate({ state, event, context }) {
      const method = protocolMethod(event)
      const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
      if (!handler) return unmappedCodexAppServerEvent(event)
      return handler({ state, event, context, method, row: eventPayload(event) })
    },
  }
}
