import { For, Match, Switch, type Component } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import type { Project } from "@/server"
import { Button, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { addProjectPath, projectPath } from "../routes"
import { useProjects } from "../store"
import { ProjectRow } from "./project-row"
import { RemoveProjectDialog } from "./remove-project-dialog"
import { RenameProjectDialog } from "./rename-project-dialog"
import "./projects.css"

export const ProjectsSidebarSection: Component = () => {
  const t = useProjectsText()
  const projects = useProjects()
  const navigate = useNavigate()
  const location = useLocation()
  const dialog = useDialog()
  const failed = () => {
    const state = projects()
    return state.kind === "failed" ? state.error : undefined
  }
  const rows = () => {
    const state = projects()
    return state.kind === "ready" ? state.data : undefined
  }
  const rename = (project: Project) => dialog.show(() => <RenameProjectDialog project={project} />)
  const remove = (project: Project) =>
    dialog.show(() => (
      <RemoveProjectDialog
        project={project}
        onRemoved={() => {
          if (location.pathname.startsWith(projectPath(project.id))) navigate("/")
        }}
      />
    ))

  return (
    <section class="flex flex-col gap-1" aria-label={t("projects.title")} data-testid="projects-section">
      <div class="flex min-h-11 items-center justify-between gap-2 px-2">
        <h2 class="projects-heading m-0">{t("projects.title")}</h2>
        <Button variant="ghost" size="small" icon="plus" onClick={() => navigate(addProjectPath)}>
          {t("projects.new")}
        </Button>
      </div>
      <Switch>
        <Match when={projects().kind === "loading"}>
          <p class="projects-hint projects-placeholder m-0 px-2">{t("projects.loading")}</p>
        </Match>
        <Match when={failed()}>
          {(error) => (
            <p class="projects-alert m-0 px-2" role="alert">
              {t("projects.failed")}: {error().message}
            </p>
          )}
        </Match>
        <Match when={rows()}>
          {(items) => (
            <ul class="m-0 flex list-none flex-col p-0">
              <For each={items()} fallback={<li class="projects-hint px-2">{t("projects.empty")}</li>}>
                {(project) => (
                  <ProjectRow
                    project={project}
                    active={location.pathname === projectPath(project.id)}
                    onOpen={() => navigate(projectPath(project.id))}
                    onRename={() => rename(project)}
                    onRemove={() => remove(project)}
                  />
                )}
              </For>
            </ul>
          )}
        </Match>
      </Switch>
    </section>
  )
}
