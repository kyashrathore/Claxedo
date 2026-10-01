import type { HarnessEventAdapter } from "../../../translate/adapter"
import { createAcpTranslatorState, type SessionState } from "./state"
import { isSessionUpdate, translateSessionUpdate } from "./translate-session-update"
import { diagnoseTranslation, shape, type AcpDiagnostics } from "./diagnostics"

export type AcpEventTranslatorState = SessionState

export type AcpEventTranslatorOptions = {
  client: string
  preserveUserMessageChunks?: boolean
}

export function createAcpEventTranslator(options: AcpEventTranslatorOptions): HarnessEventAdapter<AcpEventTranslatorState> {
  return {
    name: options.client,
    createInitialState: () => createAcpTranslatorState(options.client),
    translate({ state, event }) {
      if (event.method && event.method !== "session/update") return []
      const diagnostics: AcpDiagnostics = { items: [] }
      if (!isSessionUpdate(event.payload)) {
        diagnoseTranslation(diagnostics, "acp.dropped_content", {
          reason: "unknown_session_update",
          shape: shape(event.payload),
        })
        return { events: [], diagnostics: diagnostics.items }
      }
      const events = translateSessionUpdate(event.payload, {
        state,
        diagnostics,
        preserveUserMessageChunks: options.preserveUserMessageChunks,
      })
      return {
        events,
        diagnostics: diagnostics.items,
      }
    },
  }
}
