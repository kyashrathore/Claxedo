import type { Component } from "solid-js"
import type { PageProps } from "@/shell"
import { useAddProjectFlow } from "../add-project"
import { useProjectsText } from "../i18n"
import { useCreatedProjectOpener } from "../open"
import { AddProjectSteps } from "./add-project-steps"
import "./projects.css"

export const AddProjectPage: Component<PageProps> = () => {
  const t = useProjectsText()
  const flow = useAddProjectFlow(useCreatedProjectOpener())

  return (
    <div class="projects-add-page" data-testid="add-project-page">
      <h1 class="m-0 mb-4 shrink-0 text-lg font-semibold">{t("projects.add.title")}</h1>
      <AddProjectSteps flow={flow} />
    </div>
  )
}
