import { Show } from "solid-js"
import { pickProjectFolderWith } from "@/projects"
import { useServer } from "@/server"
import type { PageProps } from "@/shell"
import { useDialog } from "@/ui"
import { OnboardingWizard } from "./wizard"
import "./first-project-canvas.css"

export function FirstProjectCanvas(_props: PageProps) {
  const server = useServer()
  const dialog = useDialog()
  const capabilities = () => server.capabilities()
  return (
    <main class="first-project" data-testid="first-project-canvas">
      <div class="first-project-field" aria-hidden="true" />
      <div class="first-project-glow" aria-hidden="true" />
      <div class="first-project-vignette" aria-hidden="true" />
      <div class="first-project-content">
        <Show when={capabilities()}>
          {(known) => <OnboardingWizard localExecution={known().thisMachine !== undefined} pickFolder={pickProjectFolderWith(dialog)} />}
        </Show>
      </div>
    </main>
  )
}
