import { createSignal, For, Match, Switch, type Component } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import type { Project } from "@/server"
import { projectsText } from "../i18n"
import { addProjectPath, projectPath } from "../routes"
import { useProjects } from "../store"
import { buttonAttrs } from "./button-attrs"
import { ProjectRow } from "./project-row"
import { RemoveProjectDialog } from "./remove-project-dialog"
import { RenameProjectDialog } from "./rename-project-dialog"
import "./projects.css"

export const ProjectsSidebarSection: Component = () => {
  const projects = useProjects()
  const navigate = useNavigate()
  const location = useLocation()
  const [renaming, setRenaming] = createSignal<Project>()
  const [removing, setRemoving] = createSignal<Project>()
  const failed = () => {
    const state = projects()
    return state.kind === "failed" ? state.error : undefined
  }
  const rows = () => {
    const state = projects()
    return state.kind === "ready" ? state.data : undefined
  }

  return (
    <section class="flex flex-col gap-1" aria-label={projectsText("projects.title")} data-testid="projects-section">
      <div class="flex min-h-11 items-center justify-between gap-2 px-2">
        <h2 class="m-0 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--v2-text-text-muted)" }}>
          {projectsText("projects.title")}
        </h2>
        <button type="button" {...buttonAttrs("ghost", "normal")} onClick={() => navigate(addProjectPath)}>
          {projectsText("projects.new")}
        </button>
      </div>
      <Switch>
        <Match when={projects().kind === "loading"}>
          <p class="projects-hint projects-placeholder px-2">{projectsText("projects.loading")}</p>
        </Match>
        <Match when={failed()}>
          {(error) => (
            <p class="projects-alert px-2" role="alert">
              {projectsText("projects.failed")}: {error().message}
            </p>
          )}
        </Match>
        <Match when={rows()}>
          {(items) => (
            <ul class="m-0 flex list-none flex-col p-0">
              <For each={items()} fallback={<li class="projects-hint px-2">{projectsText("projects.empty")}</li>}>
                {(project) => (
                  <ProjectRow
                    project={project}
                    active={location.pathname === projectPath(project.id)}
                    onOpen={(item) => navigate(projectPath(item.id))}
                    onRename={setRenaming}
                    onRemove={setRemoving}
                  />
                )}
              </For>
            </ul>
          )}
        </Match>
      </Switch>
      <RenameProjectDialog project={renaming()} onClose={() => setRenaming(undefined)} />
      <RemoveProjectDialog
        project={removing()}
        onClose={() => setRemoving(undefined)}
        onRemoved={(project) => {
          if (location.pathname.startsWith(projectPath(project.id))) navigate("/")
        }}
      />
    </section>
  )
}
