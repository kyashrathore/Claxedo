import type { HarnessEventAdapter } from "../../core/adapter"
import { createAcpTranslatorState, type SessionState } from "./state"
import { translateAcpSessionUpdate } from "./translate-session-update"
import { createAcpDiagnostics } from "./diagnostics"

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
      const diagnostics = createAcpDiagnostics()
      const events = translateAcpSessionUpdate(event.payload as Parameters<typeof translateAcpSessionUpdate>[0], {
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
