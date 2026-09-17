import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useServer } from "@/app/connection/server"
import { serverHealthQueryOptions } from "@/app/connection/server-health"
import { useConfigOptional } from "@/app/providers/config"
import { useLayout } from "@/app/providers/layout"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import { pickProjectFolderWith } from "@/features/session/ui/components/session-pick-project-folder"
import type { NewSessionProjectSelection } from "@/features/session/ui/components/session-new-design-view"
import { refreshProjectInventory } from "@/features/workspaces/data/query/project-ensure"
import { ProjectCreateForm } from "@/features/workspaces/ui/project-create-form"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { centralTransportForDeployment } from "@/platform/runtime/transport"
import { validWorktree } from "@/platform/sync/worktree"

import "./first-project-canvas.css"

/**
 * The canvas with no project on the server: the create form itself, not a
 * picker over an empty list. Every later project is created from the
 * composer's Project chip, which renders the same `ProjectCreateForm`; this
 * host is the one case where there is no composer to hang it off, so it
 * renders the form as the screen.
 */
export function FirstProjectCanvas(props: {
  onDiagnostics?: () => void
  /** The project just created; the shell opens it and the normal composer takes over. */
  onProjectCreated?: (project: NewSessionProjectSelection) => void
}) {
  const server = useServer()
  const config = useConfigOptional()
  const dialog = useDialog()
  const layout = useLayout()
  const platform = usePlatform()
  const queryOptions = useShellQueryOptions()
  let nameField: HTMLInputElement | undefined

  const signedControlPlane = createMemo(
    () =>
      centralTransportForDeployment({ serverUrl: server.url, authEnabled: config?.authEnabled === true }) ===
      "signed-web",
  )
  const health = useQuery(() =>
    serverHealthQueryOptions({
      server: { url: server.url },
      fetch: platform.fetch ?? globalThis.fetch,
      enabled: !!server.url,
    }),
  )
  // The server's own account of whether it runs projects on its filesystem.
  // Nothing back means "the product this mode has always been", which is what
  // the composer's Project chip resolves too.
  const localExecution = () => health.data?.localExecution ?? !signedControlPlane()

  // "New Project" in the rail and the desktop menu raise an intent rather than
  // opening anything; with no project this screen is the only surface that can
  // answer it, and the name field is where the answer starts.
  onCleanup(layout.projects.registerCreateSurface())
  createEffect(() => {
    if (!layout.projects.createPending()) return
    nameField?.focus()
    layout.projects.answerCreate()
  })

  return (
    <div class="first-project" data-testid="first-project-canvas">
      <div class="first-project-field" aria-hidden="true" />
      <div class="first-project-glow" aria-hidden="true" />
      <div class="first-project-vignette" aria-hidden="true" />
      <div class="first-project-content">
        <h1 class="first-project-headline first-project-reveal">Start with a project</h1>
        <p class="first-project-lede first-project-reveal" style={{ "--first-project-delay": "40ms" }}>
          A project is a repository and a name. Point Claxedo at a folder on this machine, or give it a repository to
          clone — where the work runs is a later question.
        </p>
        <div class="first-project-card first-project-reveal" style={{ "--first-project-delay": "80ms" }}>
          <ProjectCreateForm
            size="comfortable"
            nameField={(element) => (nameField = element)}
            baseUrl={server.url}
            localExecution={localExecution()}
            pickFolder={pickProjectFolderWith(dialog)}
            onCreated={(project) => {
              // A checkout the app cannot open as a local worktree (a root, a
              // relative path, the cloud container's own `/workspace`) is
              // refused here: the form stays put so the user can pick again.
              if (project.checkoutDirectory && !validWorktree(project.checkoutDirectory)) {
                showToast({ title: "Invalid project path", description: project.checkoutDirectory, variant: "error" })
                return
              }
              // A repository project with no checkout yet (a hosted plane)
              // executes nothing at creation; it only has to list.
              if (!project.checkoutDirectory) {
                void refreshProjectInventory(queryOptions.projects())
                return
              }
              props.onProjectCreated?.({ id: project.id, worktree: project.checkoutDirectory })
            }}
          />
        </div>
        <Show when={props.onDiagnostics}>
          {(onDiagnostics) => (
            <button
              type="button"
              data-testid="empty-diagnostics-trigger"
              class="first-project-diagnostics first-project-reveal"
              style={{ "--first-project-delay": "200ms" }}
              onClick={onDiagnostics()}
            >
              Diagnostics
            </button>
          )}
        </Show>
      </div>
    </div>
  )
}
