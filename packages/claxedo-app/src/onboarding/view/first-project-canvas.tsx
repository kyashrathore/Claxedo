import { Show } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useAuth } from "@/auth"
import { pickProjectFolderWith } from "@/projects"
import { useServer } from "@/server"
import type { PageProps } from "@/shell"
import { ArtworkPlate, useDialog } from "@/ui"
import { OnboardingWizard } from "./wizard"
import "./first-project-canvas.css"

export function FirstProjectCanvas(_props: PageProps) {
  const server = useServer()
  const auth = useAuth()
  const dialog = useDialog()
  const capabilities = () => server.capabilities()
  const machines = useQuery(() => ({ ...server.queries.machines.list(), enabled: capabilities()?.thisMachine === undefined }))
  return (
    <main class="first-project" data-testid="first-project-canvas">
      <ArtworkPlate />
      <div class="first-project-content">
        <Show when={capabilities()}>
          {(known) => (
            <OnboardingWizard
              facts={{
                localExecution: known().thisMachine !== undefined,
                cloudAvailable: auth.state().kind === "signedIn",
                machineConnected: machines.data?.some((machine) => machine.enrolled),
              }}
              pickFolder={pickProjectFolderWith(dialog)}
            />
          )}
        </Show>
      </div>
    </main>
  )
}
