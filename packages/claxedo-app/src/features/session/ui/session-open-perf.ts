import { createEffect, on, type Accessor } from "solid-js"
import { sessionPerf } from "@/platform/performance/session-perf"

/**
 * The phases of a session open as the screen experiences them, from the rail
 * click (or the route) to a readable transcript: screen mounted, messages
 * ready, first fold ready. Keyed by session id, so a switch inside one mounted
 * screen records its own open. See `session-perf.ts` for how to read it.
 */
export function trackSessionOpen(input: {
  sessionId: Accessor<string | undefined>
  directory: Accessor<string>
  messagesReady: Accessor<boolean>
  firstFoldReady: Accessor<boolean>
  messageCount: Accessor<number>
}) {
  createEffect(on(input.sessionId, (id) => {
    if (id) sessionPerf.openPhase(id, "screen-mounted", { directory: input.directory() })
  }))
  createEffect(() => {
    const id = input.sessionId()
    if (id && input.messagesReady()) sessionPerf.openPhase(id, "messages-ready", { messages: input.messageCount() })
  })
  createEffect(() => {
    const id = input.sessionId()
    if (id && input.firstFoldReady()) sessionPerf.openPhase(id, "first-fold-ready", { messages: input.messageCount() })
  })
}
