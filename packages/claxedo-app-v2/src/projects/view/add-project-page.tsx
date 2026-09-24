import type { Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useCloud } from "@/cloud"
import type { PageProps } from "@/shell/types"
import { useProjectsServer } from "../api"
import { createAddProjectFlow, type ProjectCreated } from "../add-project"
import { projectsText } from "../i18n"
import { placementDraftPath, projectPath } from "../routes"
import { AddProjectSteps } from "./add-project-steps"

export function createdDestination(created: ProjectCreated): string {
  return created.placementId ? placementDraftPath(created.placementId, created.harnessId) : projectPath(created.projectId)
}

export const AddProjectPage: Component<PageProps> = () => {
  const navigate = useNavigate()
  const flow = createAddProjectFlow({
    server: useProjectsServer(),
    cloud: useCloud(),
    onCreated: (created) => navigate(createdDestination(created)),
  })

  return (
    <div class="mx-auto flex h-full w-full max-w-xl min-h-0 flex-col p-4 sm:p-6" data-testid="add-project-page">
      <h1 class="m-0 mb-4 shrink-0 text-lg font-semibold">{projectsText("projects.add.title")}</h1>
      <AddProjectSteps flow={flow} />
    </div>
  )
}
