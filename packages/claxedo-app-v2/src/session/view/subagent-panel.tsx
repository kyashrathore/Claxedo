import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { sessionId, useServer, type SessionRef } from "@/server"
import type { PanelView, PanelViewProps } from "@/shell"
import { SessionSurface } from "./session-screen"

const FOCUS_WAIT_FRAMES = 30

function childHeading(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-session-timeline-session-id="${CSS.escape(id)}"] [data-subagent-child-heading]`,
  )
}

function focusChildHeading(id: () => string): void {
  let handle: number | undefined
  const cancel = () => {
    if (handle !== undefined) cancelAnimationFrame(handle)
    handle = undefined
  }
  createEffect(
    on(id, (current) => {
      cancel()
      let remaining = FOCUS_WAIT_FRAMES
      const attempt = () => {
        handle = undefined
        const heading = childHeading(current)
        if (heading) {
          heading.focus({ preventScroll: true })
          return
        }
        remaining -= 1
        if (remaining > 0) handle = requestAnimationFrame(attempt)
      }
      handle = requestAnimationFrame(attempt)
    }),
  )
  onCleanup(cancel)
}

function SubagentPanel(props: PanelViewProps) {
  const server = useServer()
  const ref = createMemo((): SessionRef | undefined => {
    const placement = server.placements.byId(props.placementId)
    return placement
      ? { projectId: placement.projectId, placementId: props.placementId, sessionId: sessionId(props.sessionId) }
      : undefined
  })
  focusChildHeading(() => props.sessionId)
  return (
    <div class="relative flex h-full min-h-0 flex-col overflow-hidden">
      <Show when={ref()} keyed>
        {(current) => <SessionSurface sessionRef={current} active readOnly />}
      </Show>
    </div>
  )
}

export const subagentPanelView: PanelView = { kind: "subagent", view: SubagentPanel }
