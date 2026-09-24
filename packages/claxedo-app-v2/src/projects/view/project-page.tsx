import { createSignal, Match, Show, Switch, type Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { CloudWorkspaces } from "@/cloud"
import { projectId, type Project } from "@/server"
import type { PageProps } from "@/shell/types"
import { projectsText } from "../i18n"
import { sourceLabel } from "../model"
import { useProject } from "../store"
import { buttonAttrs } from "./button-attrs"
import { PlacementList } from "./placement-list"
import { RemoveProjectDialog } from "./remove-project-dialog"
import { RenameProjectDialog } from "./rename-project-dialog"
import "./projects.css"

const ProjectHeader: Component<{ project: Project; onRename: () => void; onRemove: () => void }> = (props) => (
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex min-w-0 flex-col gap-1">
      <h1 class="m-0 truncate text-lg font-semibold" data-testid="project-name">
        {props.project.name}
      </h1>
      <p class="projects-hint m-0 truncate" data-testid="project-source">
        {projectsText("projects.source")}: {props.project.source ? sourceLabel(props.project.source) : projectsText("projects.source.none")}
      </p>
    </div>
    <div class="flex shrink-0 gap-2">
      <button type="button" {...buttonAttrs("outline")} onClick={props.onRename}>
        {projectsText("projects.rename")}
      </button>
      <button type="button" {...buttonAttrs("danger")} onClick={props.onRemove}>
        {projectsText("projects.remove")}
      </button>
    </div>
  </header>
)

export const ProjectPage: Component<PageProps> = (props) => {
  const id = () => projectId(props.params.projectId ?? "")
  const project = useProject(id)
  const navigate = useNavigate()
  const [renaming, setRenaming] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  const current = () => {
    const state = project()
    return state.kind === "ready" ? state.project : undefined
  }
  const failed = () => {
    const state = project()
    return state.kind === "failed" ? state.error : undefined
  }

  return (
    <div class="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-4 sm:p-6" data-testid="project-page" data-project-id={id()}>
      <Switch>
        <Match when={project().kind === "loading"}>
          <p class="projects-hint projects-placeholder">{projectsText("projects.loading")}</p>
        </Match>
        <Match when={project().kind === "missing"}>
          <p class="projects-alert" role="alert" data-testid="project-missing">
            {projectsText("projects.missing")}
          </p>
        </Match>
        <Match when={failed()}>
          {(error) => (
            <p class="projects-alert" role="alert">
              {error().message}
            </p>
          )}
        </Match>
        <Match when={current()}>
          {(item) => (
            <>
              <ProjectHeader project={item()} onRename={() => setRenaming(true)} onRemove={() => setRemoving(true)} />
              <PlacementList projectId={id} />
              <Show when={item().source?.kind !== "folder"}>
                <CloudWorkspaces projectId={id} />
              </Show>
            </>
          )}
        </Match>
      </Switch>
      <RenameProjectDialog project={renaming() ? current() : undefined} onClose={() => setRenaming(false)} />
      <RemoveProjectDialog project={removing() ? current() : undefined} onClose={() => setRemoving(false)} onRemoved={() => navigate("/")} />
    </div>
  )
}
