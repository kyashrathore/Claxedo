import type { HarnessEventAdapter } from "../../core/adapter"
import { createAcpTranslatorState, toKeyedMap, type SessionState } from "./state"
import { translateAcpSessionUpdate } from "./translate-session-update"
import { createAcpDiagnostics, diagnoseTranslation, shape } from "./diagnostics"
import { isSessionUpdate } from "./validation"

export type AcpEventTranslatorState = SessionState

export type AcpEventTranslatorOptions = {
  client: string
  /**
   * ACP clients usually already own user prompt rendering upstream, so replaying
   * user_message_chunk would duplicate the message in live projections.
   */
  preserveUserMessageChunks?: boolean
}

export function createAcpEventTranslator(options: AcpEventTranslatorOptions): HarnessEventAdapter<AcpEventTranslatorState> {
  return {
    name: options.client,
    createInitialState: () => createAcpTranslatorState(options.client),
    translate({ state, event }) {
      if (event.method && event.method !== "session/update") return []
      state.assistantTextByMessageId = toKeyedMap(state.assistantTextByMessageId)
      state.assistantThinkingByMessageId = toKeyedMap(state.assistantThinkingByMessageId)
      state.tools = toKeyedMap(state.tools)
      const diagnostics = createAcpDiagnostics()
      if (!isSessionUpdate(event.payload)) {
        diagnoseTranslation(diagnostics, "acp.dropped_content", {
          reason: "unknown_session_update",
          shape: shape(event.payload),
        })
        return { events: [], diagnostics: diagnostics.items }
      }
      const events = translateAcpSessionUpdate(event.payload, {
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
