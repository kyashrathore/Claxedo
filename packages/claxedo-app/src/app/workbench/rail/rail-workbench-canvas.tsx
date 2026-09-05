import { Show, Suspense, createMemo, lazy, type Accessor, type ParentProps } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { SDKProvider } from "@/app/providers/sdk/sdk"
import { useServer } from "@/app/connection/server"
import { useConfigOptional } from "@/app/providers/config"
import { centralTransportForDeployment } from "@/platform/runtime/transport"
import { NewSessionDesignView, type NewSessionProjectSelection } from "@/features/session/ui/components/session-new-design-view"
import { pickProjectFolderWith } from "@/features/session/ui/components/session-pick-project-folder"

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
  onCloseFocusedPane: (paneId: string, contentId: string | null) => void
  onDiagnostics?: () => void
  onNewProject?: () => void
  /** A project the empty canvas's composer just created; the shell opens it. */
  onProjectCreated?: (project: NewSessionProjectSelection) => void
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
        retainedHiddenLimit={retainedHiddenLimit}
        onCloseFocusedPane={props.onCloseFocusedPane}
        renderEmpty={() => (
          <Show
            when={props.emptyDraftDirectory()}
            fallback={
              <NoProjectComposer onProjectCreated={props.onProjectCreated}>
                {ONBOARDING_V1
                  ? <OnboardingEmptyState onDiagnostics={props.onDiagnostics} onNewProject={props.onNewProject} />
                  : <LegacyEmptyState onDiagnostics={props.onDiagnostics} onNewProject={props.onNewProject} />}
              </NoProjectComposer>
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
      <Button icon="plus-small" onClick={props.onNewProject}>New Project</Button>
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

/**
 * The canvas before the first project exists: the same composer chip row a
 * draft shows (`NewSessionDesignView`), mounted with no project, so the first
 * project is created exactly where every later one is — the Project chip's
 * "Create project…" panel. The full draft pane needs a project directory for
 * its provider chain, so the pane below stays for the empty-draft-with-project
 * case; this only hosts the chip row over the empty-state copy.
 */
function NoProjectComposer(props: ParentProps<{ onProjectCreated?: (project: NewSessionProjectSelection) => void }>) {
  const server = useServer()
  const config = useConfigOptional()
  const dialog = useDialog()
  const signed = () =>
    centralTransportForDeployment({ serverUrl: server.url, authEnabled: config?.authEnabled === true }) === "signed-web"
  return (
    <div data-testid="no-project-composer" class="flex h-full w-full flex-col">
      <SDKProvider directory="">
        <NewSessionDesignView
          worktree=""
          workspaceKind="local"
          onWorktreeChange={() => {}}
          onWorkspaceKindChange={() => {}}
          signedControlPlane={signed()}
          sandboxEnabled={config?.sandboxEnabled}
          pickProjectFolder={pickProjectFolderWith(dialog)}
          onProjectChange={(_directory, project) => props.onProjectCreated?.(project)}
        >
          {/* The composer lifts its body over the chip row's bottom padding;
              give the empty-state copy the room a prompt card would take. */}
          <div class="px-3 pb-2 pt-6">{props.children}</div>
        </NewSessionDesignView>
      </SDKProvider>
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
