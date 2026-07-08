import { Show, Suspense, createMemo, lazy, type Accessor } from "solid-js"

import { Button } from "@opencode-ai/ui/button"

import { Workbench } from "../layout"
import { ContentRenderer } from "../content-renderers"
import type { ContentMeta } from "../state"

const SessionContent = lazy(() =>
  import("../content-renderers/session-content").then((m) => ({ default: m.SessionContent })),
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
  onNewProject?: () => void
}) {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <Workbench
        renderContent={(id, ctx) => (
          <ContentRenderer id={id} ctx={ctx} fallbackDirectory={props.emptyDraftDirectory} />
        )}
        maxMountedContents={12}
        mountCapCandidate={(id) => props.state.meta.get(id)?.type === "session"}
        renderEmpty={() => (
          <Show
            when={props.emptyDraftDirectory()}
            fallback={
              <div class="flex flex-col items-center justify-center h-full text-text-weak gap-4">
                <div class="flex flex-col items-center gap-4">
                  <span class="text-14-regular">No projects yet. Create one to get started.</span>
                  <Button icon="plus-small" onClick={() => props.onNewProject?.()}>
                    New Project
                  </Button>
                </div>
              </div>
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
          window.dispatchEvent(new Event("opencode:terminal-fit"))
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

  return (
    <div data-testid="empty-draft-session-composer" class="h-full w-full">
      <Suspense fallback={<div class="size-full bg-background-base" />}>
        <SessionContent
          meta={meta()}
          ctx={{
            paneId: props.paneId ?? "",
            isFocused: () => true,
            isVisible: () => true,
            requestClose: () => {},
            requestFocus: () => {},
          }}
        />
      </Suspense>
    </div>
  )
}
