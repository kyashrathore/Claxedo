import type { Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import type { PageProps } from "@/shell/types"
import { useAddProjectFlow, type ProjectCreated } from "../add-project"
import { useProjectsText } from "../i18n"
import { placementDraftPath, projectPath } from "../routes"
import { AddProjectSteps } from "./add-project-steps"
import "./projects.css"

export function createdDestination(created: ProjectCreated): string {
  return created.placementId ? placementDraftPath(created.placementId, created.harnessId) : projectPath(created.projectId)
}

export const AddProjectPage: Component<PageProps> = () => {
  const t = useProjectsText()
  const navigate = useNavigate()
  const flow = useAddProjectFlow((created) => navigate(createdDestination(created)))

  return (
    <div class="projects-add-page" data-testid="add-project-page">
      <h1 class="m-0 mb-4 shrink-0 text-lg font-semibold">{t("projects.add.title")}</h1>
      <AddProjectSteps flow={flow} />
    </div>
  )
}
