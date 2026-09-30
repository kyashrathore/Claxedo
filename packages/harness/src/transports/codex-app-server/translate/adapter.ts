import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapter } from "../../../translate/adapter"
import { accountHandlers } from "./account"
import { eventPayload, protocolMethod, frameRequestId, type CodexHandlers, type CodexThreadModel } from "./frame"
import { hookHandlers } from "./hooks"
import { itemHandlers } from "./item-lifecycle"
import { messageHandlers } from "./message-items"
import { diagnosticForEvent, noticeHandlers, unmappedCodexAppServerEvent } from "./notices"
import { usageHandlers } from "./reported-model"
import { requestHandlers } from "./server-requests"
import { createCodexAppServerAdapterState, type CodexAppServerAdapterState } from "./state"
import { toolStreamHandlers } from "./tool-stream"
import { turnErrorMessage } from "./turn-errors"
import { turnHandlers } from "./turn-lifecycle"

export const CODEX_DESCENDANT_ERROR_METHOD = "codex/descendant-error"

const handlers: CodexHandlers = {
  ...messageHandlers,
  ...itemHandlers,
  ...toolStreamHandlers,
  ...turnHandlers,
  ...usageHandlers,
  ...requestHandlers,
  ...accountHandlers,
  ...noticeHandlers,
  ...hookHandlers,
}

export function codexAppServerAdapter(options: { threadModel?: CodexThreadModel } = {}): HarnessEventAdapter<CodexAppServerAdapterState> {
  return {
    name: "codex-app-server",
    createInitialState: createCodexAppServerAdapterState,
    translate({ state, event, context }) {
      if (event.method === CODEX_DESCENDANT_ERROR_METHOD) {
        const row = eventPayload(event)
        return [diagnosticForEvent({
          code: "codex_app_server.descendant_error",
          message: turnErrorMessage(asRecord(row.error), undefined) ?? text(row.message) ?? "A nested Codex subagent failed",
          severity: "warn",
          event,
        })]
      }
      const method = protocolMethod(event)
      const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
      if (!handler) return unmappedCodexAppServerEvent(event)
      return handler({ state, event, context, method, row: eventPayload(event), requestId: frameRequestId(event), threadModel: options.threadModel })
    },
  }
}
