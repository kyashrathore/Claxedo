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
    if (!id) return
    sessionPerf.openStart(id, "route")
    sessionPerf.openPhase(id, "screen-mounted", { directory: input.directory() })
    // Readiness belongs to this open. Recreate its observer after the start
    // when the session changes, including switches to already-ready sessions.
    createEffect(() => {
      if (input.messagesReady()) sessionPerf.openPhase(id, "messages-ready", { messages: input.messageCount() })
      if (input.firstFoldReady()) sessionPerf.openPhase(id, "first-fold-ready", { messages: input.messageCount() })
    })
  }))
}
