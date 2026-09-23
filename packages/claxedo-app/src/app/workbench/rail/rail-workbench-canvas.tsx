import { Show, Suspense, createMemo, lazy, type Accessor } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { PaneCtxProvider } from "../context/pane-ctx"
import type { NewSessionProjectSelection } from "@/features/session/ui/components/session-new-design-view"

import { Workbench, type PaneCtx } from "../workbench/index"
import { contentSurfacePaneDraggable } from "@/app/integrations/first-party-content-surfaces"
import { createMountIdleGovernor } from "../workbench/mount-idle-governor"
import { ContentRenderer } from "../content/index"
import type { ContentMeta } from "../state/index"
import { emitTerminalFit } from "../../../features/terminal/workbench/terminal-fit"
import { FirstProjectCanvas } from "./first-project-canvas"
import { MainContentReady } from "../../shell-revealed"

const SessionContent = lazy(() =>
  import("../../../features/session/ui/content/session-content").then((m) => ({ default: m.SessionContent })),
)

type RailWorkbenchState = {
  wb: {
    state: {
      focusedPaneId?: string | null
    }
  }
  meta: {
    get: (contentId: string) => ContentMeta | undefined
  }
  layout: {
    _cleanupOnClose: (contentId: string, reason: "user" | "panic") => void
  }
}

export function RailWorkbenchCanvas(props: {
  state: RailWorkbenchState
  emptyDraftDirectory: Accessor<string | undefined>
  onCloseFocusedPane: (paneId: string, contentId: string | null) => void
  onDiagnostics?: () => void
  /** A project the first-project canvas just created; the shell opens it. */
  onProjectCreated?: (project: NewSessionProjectSelection) => void
}) {
  // Keep only the three most-recent hidden sessions mounted. The bounded
  // latest-surface hydrate makes a remount cheap; retaining 23 hidden pages made
  // Solid and layout work grow with browsing history and broke the 50 ms cold
  // switch budget. Visible split panes and terminals remain exempt. After a few
  // idle minutes even these three unload, then refill one slot at a time.
  const retainedHiddenLimit = createMountIdleGovernor({ baseLimit: 3, idleAfterMs: 180_000 })

  return (
    <div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <Workbench
        renderContent={(id, ctx) => (
          <ContentRenderer id={id} ctx={ctx} fallbackDirectory={props.emptyDraftDirectory} />
        )}
        maxMountedContents={4}
        mountPolicy="visible-once"
        mountCapCandidate={(id) => props.state.meta.get(id)?.type === "session"}
        paneDraggable={(id) => contentSurfacePaneDraggable(props.state.meta.get(id)?.type)}
        retainedHiddenLimit={retainedHiddenLimit}
        onCloseFocusedPane={props.onCloseFocusedPane}
        renderEmpty={() => (
          <Show
            when={props.emptyDraftDirectory()}
            fallback={
              <>
                {/* The empty states carry no composer; their mount is the
                    readiness the boot splash waits on. The draft session's
                    release is the composer poll in `BootSplashOverlay`. */}
                <MainContentReady />
                <FirstProjectCanvas onDiagnostics={props.onDiagnostics} onProjectCreated={props.onProjectCreated} />
              </>
            }
          >
            {(workspaceDir) => (
              <EmptyDraftSessionComposer
                workspaceDir={workspaceDir()}
                paneId={props.state.wb.state.focusedPaneId ?? undefined}
              />
            )}
          </Show>
        )}
        onPaneResize={() => {
          emitTerminalFit()
        }}
        onContentClose={(id, reason) => {
          props.state.layout._cleanupOnClose(id, reason === "stale" ? "panic" : "user")
        }}
      />
    </div>
  )
}

function EmptyDraftSessionComposer(props: {
  workspaceDir: string
  paneId?: string
}) {
  const meta = createMemo<ContentMeta>(() => ({
    id: "empty-draft-session-composer",
    type: "session",
    scope: "directory",
    directory: props.workspaceDir,
    sessionId: "new",
    content: {
      type: "session",
      directory: props.workspaceDir,
      sessionId: "new",
      title: "New Session",
    },
  }))

  let rootEl: HTMLDivElement | undefined
  // The empty state stands in for a workbench slot while there is no content
  // to mount, so it is the one surface on screen: its keydown may bind to
  // `document` directly, and its own element is the drop zone.
  const ctx: PaneCtx = {
    paneId: props.paneId ?? "",
    isFocused: () => true,
    isVisible: () => true,
    element: () => rootEl,
    onKeyDown: (handler) => makeEventListener(document, "keydown", handler),
    requestClose: () => {},
    requestFocus: () => {},
    presentation: () => "docked",
  }
  return (
    <div ref={rootEl} data-testid="empty-draft-session-composer" class="h-full w-full">
      <Suspense fallback={<div class="size-full bg-background-base" />}>
        <PaneCtxProvider ctx={ctx}>
          <SessionContent meta={meta()} ctx={ctx} />
        </PaneCtxProvider>
      </Suspense>
    </div>
  )
}
