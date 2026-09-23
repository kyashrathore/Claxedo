import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useServer } from "@/app/connection/server"
import { serverHealthQueryOptions } from "@/app/connection/server-health"
import { useLayout } from "@/app/providers/layout"
import { useOnboardingFunnel } from "@/app/integrations/onboarding-funnel"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import { pickProjectFolderWith } from "@/features/session/ui/components/session-pick-project-folder"
import type { NewSessionProjectSelection } from "@/features/session/ui/components/session-new-design-view"
import { OnboardingWizard } from "@/features/onboarding/wizard"
import { refreshProjectInventory } from "@/features/workspaces/data/query/project-ensure"
import { cloudWorkspaceSource, createCloudWorkspace } from "@/features/workspaces/data/workspace-create-api"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useDeploymentPosture } from "@/app/connection/deployment-posture"
import { workspaceSessionRoute } from "@/platform/identity/route"

import "./first-project-canvas.css"

/**
 * The canvas with no project on the server: the first-run wizard, as the
 * whole screen. Every later project is created from the composer's Project
 * chip; this host is the one case where there is no composer to hang it off.
 */
export function FirstProjectCanvas(props: {
  onDiagnostics?: () => void
  /** The project the wizard created; the shell opens it and the normal composer takes over. */
  onProjectCreated?: (project: NewSessionProjectSelection) => void
}) {
  const server = useServer()
  const posture = useDeploymentPosture()
  const dialog = useDialog()
  const layout = useLayout()
  const platform = usePlatform()
  const navigate = useNavigate()
  const queryOptions = useShellQueryOptions()
  const funnel = useOnboardingFunnel()
  let leadField: HTMLElement | undefined

  const signedControlPlane = createMemo(() => posture.issuesSessions() === true)
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
  // The wizard opens on the server's answer, never on the guess. On a signed
  // local server the guess is the other product, and a form that mounts as the
  // hosted product and then switches drops its in-flight code-host fetch.
  // solid-js 1.9 leaves that fetch registered with the transition that mounted
  // the canvas (Remove project runs one), so that transition never commits.
  const productKnown = () => !health.isLoading

  // "New Project" in the rail and the desktop menu raise an intent rather than
  // opening anything; with no project this screen is the only surface that can
  // answer it, and the wizard's leading control is where the answer starts.
  onCleanup(layout.projects.registerCreateSurface())
  createEffect(() => {
    if (!layout.projects.createPending() || !productKnown()) return
    leadField?.focus()
    layout.projects.answerCreate()
  })

  return (
    <div class="first-project" data-testid="first-project-canvas">
      <div class="first-project-field" aria-hidden="true" />
      <div class="first-project-glow" aria-hidden="true" />
      <div class="first-project-vignette" aria-hidden="true" />
      <div class="first-project-content">
        <Show when={productKnown()}>
          <OnboardingWizard
            baseUrl={server.url}
            localExecution={localExecution()}
            pickFolder={pickProjectFolderWith(dialog)}
            emit={(event) => funnel.emit(event)}
            leadField={(element) => (leadField = element)}
            onProjectCreated={(project) => props.onProjectCreated?.({ id: project.id, worktree: project.worktree })}
            createCloudWorkspace={async (input) => {
              // The hosted plane's project is its first cloud workspace; the
              // route it lands on shows the sandbox coming up.
              const created = await createCloudWorkspace({
                baseUrl: server.url,
                projectName: input.projectName,
                ...cloudWorkspaceSource(input.source),
              })
              await refreshProjectInventory(queryOptions.projects()).catch(() => undefined)
              navigate(workspaceSessionRoute(created.workspaceId))
            }}
            footer={
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
            }
          />
        </Show>
      </div>
    </div>
  )
}
