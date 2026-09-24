import { Match, Show, Switch, type Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { CloudWorkspacesSection } from "@/cloud"
import { projectId, type Project } from "@/server"
import type { PageProps } from "@/shell"
import { Button, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { sourceLabel } from "../model"
import { usePlacementOpener } from "../open"
import { useProject } from "../store"
import { PlacementList } from "./placement-list"
import { RemoveProjectDialog } from "./remove-project-dialog"
import { RenameProjectDialog } from "./rename-project-dialog"
import "./projects.css"

const ProjectHeader: Component<{ project: Project; onRename: () => void; onRemove: () => void }> = (props) => {
  const t = useProjectsText()
  return (
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <h1 class="m-0 truncate text-lg font-semibold" data-testid="project-name">
          {props.project.name}
        </h1>
        <p class="projects-hint m-0 truncate" data-testid="project-source">
          {t("projects.source")}: {props.project.source ? sourceLabel(props.project.source) : t("projects.source.none")}
        </p>
      </div>
      <div class="flex shrink-0 gap-2">
        <Button variant="outline" onClick={() => props.onRename()}>
          {t("projects.rename")}
        </Button>
        <Button variant="danger" onClick={() => props.onRemove()}>
          {t("projects.remove")}
        </Button>
      </div>
    </header>
  )
}

export const ProjectPage: Component<PageProps> = (props) => {
  const t = useProjectsText()
  const id = () => projectId(props.params.projectId ?? "")
  const project = useProject(id)
  const navigate = useNavigate()
  const opener = usePlacementOpener()
  const dialog = useDialog()
  const current = () => {
    const state = project()
    return state.kind === "ready" ? state.project : undefined
  }
  const failed = () => {
    const state = project()
    return state.kind === "failed" ? state.error : undefined
  }
  const rename = (item: Project) => dialog.show(() => <RenameProjectDialog project={item} />)
  const remove = (item: Project) => dialog.show(() => <RemoveProjectDialog project={item} onRemoved={() => navigate("/")} />)

  return (
    <div class="projects-page" data-testid="project-page" data-project-id={id()}>
      <Switch>
        <Match when={project().kind === "loading"}>
          <p class="projects-hint projects-placeholder m-0">{t("projects.loading")}</p>
        </Match>
        <Match when={project().kind === "missing"}>
          <p class="projects-alert m-0" role="alert" data-testid="project-missing">
            {t("projects.missing")}
          </p>
        </Match>
        <Match when={failed()}>
          {(error) => (
            <p class="projects-alert m-0" role="alert">
              {error().message}
            </p>
          )}
        </Match>
        <Match when={current()}>
          {(item) => (
            <>
              <ProjectHeader project={item()} onRename={() => rename(item())} onRemove={() => remove(item())} />
              <PlacementList projectId={id} />
              <Show when={item().source?.kind !== "folder"}>
                <CloudWorkspacesSection projectId={id} onOpen={opener.openPlacement} />
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
