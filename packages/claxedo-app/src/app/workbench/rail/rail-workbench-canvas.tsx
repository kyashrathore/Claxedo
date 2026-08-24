import { Show, Loading, createMemo, lazy, type Accessor } from "solid-js"
import { Button } from "@opencode-ai/ui/button"

import { Workbench } from "../workbench/index"
import { createMountIdleGovernor } from "../workbench/mount-idle-governor"
import { ContentRenderer } from "../content/index"
import type { ContentMeta } from "../state/index"
import { emitTerminalFit } from "../../../features/terminal/workbench/terminal-fit"
import { OnboardingEmptyState } from "./onboarding-empty-state"

const ONBOARDING_V1 = import.meta.env.VITE_CLAXEDO_ONBOARDING_V1 === "true"

const SessionContent = lazy(() =>
  import("../../../features/session/ui/content/session-content").then((m) => ({ default: m.SessionContent })),
)

type RailWorkbenchState = {
  wb: {
    state: {
      focusedPaneId?: string | null
    }
    selectors: {
      focusedContent: () => string | null | undefined
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
  onDiagnostics?: () => void
  onNewProject?: () => void
}) {
  const onboardingOverlayDirectory = createMemo(() => {
    if (!ONBOARDING_V1) return
    const projectDirectory = props.emptyDraftDirectory()
    if (!projectDirectory) return
    const contentId = props.state.wb.selectors.focusedContent()
    if (!contentId) return projectDirectory
    const content = props.state.meta.get(contentId)
    if (content?.type === "session" && content.sessionId === "new") return projectDirectory
  })

  // After a few minutes without input, unload every hidden session surface
  // (visible panes and terminals stay); refill one slot at a time on return
  // so the first interaction back never pays a remount burst.
  const retainedHiddenLimit = createMountIdleGovernor({ baseLimit: 24, idleAfterMs: 180_000 })

  return (
    <div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <Workbench
        renderContent={(id, ctx) => <ContentRenderer id={id} ctx={ctx} fallbackDirectory={props.emptyDraftDirectory} />}
        maxMountedContents={24}
        mountPolicy="visible-once"
        mountCapCandidate={(id) => props.state.meta.get(id)?.type === "session"}
        retainedHiddenLimit={retainedHiddenLimit}
        renderEmpty={() => (
          <Show
            when={props.emptyDraftDirectory()}
            fallback={
              ONBOARDING_V1 ? (
                <OnboardingEmptyState onDiagnostics={props.onDiagnostics} onNewProject={props.onNewProject} />
              ) : (
                <LegacyEmptyState onDiagnostics={props.onDiagnostics} onNewProject={props.onNewProject} />
              )
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
      <Show when={onboardingOverlayDirectory()}>
        {(projectDirectory) => (
          <OnboardingEmptyState
            projectDirectory={projectDirectory()}
            overlay
            fallback={false}
            onDiagnostics={props.onDiagnostics}
            onNewProject={props.onNewProject}
          />
        )}
      </Show>
    </div>
  )
}

function LegacyEmptyState(props: { onDiagnostics?: () => void; onNewProject?: () => void }) {
  return (
    <div class="flex h-full flex-col items-center justify-center gap-4 text-text-weak">
      <h1 class="sr-only">No projects yet</h1>
      <span class="text-14-regular">No projects yet. Create one to get started.</span>
      <Button icon="plus-small" onClick={props.onNewProject}>
        New Project
      </Button>
      <Show when={props.onDiagnostics}>
        {(onDiagnostics) => (
          <Button data-testid="empty-diagnostics-trigger" variant="ghost" onClick={onDiagnostics()}>
            Diagnostics
          </Button>
        )}
      </Show>
    </div>
  )
}

function EmptyDraftSessionComposer(props: { workspaceDir: string; paneId?: string }) {
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
      <Loading fallback={<div class="size-full bg-background-base" />}>
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
      </Loading>
    </div>
  )
}
