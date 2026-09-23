import { lazy } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { PaneCtxProvider } from "@/app/workbench/context/pane-ctx"
import type { PaneCtx } from "@/app/workbench/workbench/index"
import { SessionPaneScope } from "@/features/session/ui/components/session-pane-scope"

// Lazy so a workspace that never opens a subagent does not pull the session
// screen into the panel's chunk.
const SessionPage = lazy(() => import("@/features/session/ui/session-screen"))

export function ReviewWorkspaceSubagentSession(props: {
  directory: string
  sessionId: string
  tabId: string
  leafId?: string
  shown: () => boolean
}) {
  let tabEl: HTMLDivElement | undefined
  // The panel is this tab's workbench: it hands the session the slot the
  // workbench would — its element as the drop zone, and window keys only
  // while it is the shown tab.
  const ctx: PaneCtx = {
    paneId: props.leafId ?? "",
    isFocused: props.shown,
    isVisible: props.shown,
    element: () => tabEl,
    onKeyDown: (handler) =>
      makeEventListener(document, "keydown", (event) => {
        if (props.shown()) handler(event)
      }),
    requestClose: () => {},
    requestFocus: () => {},
    presentation: () => "docked",
  }
  return (
    <div ref={tabEl} class="relative flex h-full min-h-0 flex-col overflow-hidden">
      <PaneCtxProvider ctx={ctx}>
        <SessionPaneScope
          directory={props.directory}
          sessionId={() => props.sessionId}
          paneId={() => props.leafId ?? ""}
          surfaceId={() => props.tabId}
          leafId={() => props.tabId}
          active={props.shown}
        >
          {/* Docked, not floating: the panel is the surface here, so the child
              session renders as a column rather than overlaying a pane it does
              not have. SessionPage owns the conversation registration itself. */}
          <SessionPage presentation={() => "docked"} readOnly={() => true} />
        </SessionPaneScope>
      </PaneCtxProvider>
    </div>
  )
}
