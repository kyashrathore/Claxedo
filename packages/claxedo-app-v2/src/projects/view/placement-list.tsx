import { For, Match, Switch, type Accessor, type Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { unreachable } from "@/lib/machine"
import type { Placement, ProjectId } from "@/server"
import { projectsText } from "../i18n"
import { placementDraftPath } from "../routes"
import { useProjectPlacements } from "../store"
import { buttonAttrs } from "./button-attrs"

export function placementKindLabel(placement: Placement): string {
  switch (placement.kind) {
    case "folder":
      return projectsText("projects.placement.folder")
    case "worktree":
      return projectsText("projects.placement.worktree")
    case "cloud":
      return projectsText("projects.placement.cloud")
    default:
      return unreachable(placement.kind)
  }
}

export const PlacementList: Component<{ projectId: Accessor<ProjectId> }> = (props) => {
  const placements = useProjectPlacements(props.projectId)
  const navigate = useNavigate()
  const local = () => {
    const state = placements()
    return state.kind === "ready" ? state.data.filter((placement) => placement.kind !== "cloud") : []
  }
  const failed = () => {
    const state = placements()
    return state.kind === "failed" ? state.error : undefined
  }

  return (
    <section class="flex flex-col gap-2" aria-label={projectsText("projects.placements")} data-testid="placements">
      <h3 class="m-0 text-sm font-medium">{projectsText("projects.placements")}</h3>
      <Switch>
        <Match when={placements().kind === "loading"}>
          <p class="projects-hint projects-placeholder">{projectsText("projects.loading")}</p>
        </Match>
        <Match when={failed()}>
          {(error) => (
            <p class="projects-alert" role="alert">
              {error().message}
            </p>
          )}
        </Match>
        <Match when={placements().kind === "ready"}>
          <ul class="m-0 flex list-none flex-col gap-1 p-0">
            <For each={local()} fallback={<li class="projects-hint">{projectsText("projects.placements.empty")}</li>}>
              {(placement) => (
                <li class="projects-row" data-placement-id={placement.id}>
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm">{placement.label}</span>
                    <span class="projects-hint truncate">
                      {placementKindLabel(placement)}
                      {placement.path ? ` · ${placement.path}` : ""}
                      {placement.branch ? ` · ${placement.branch}` : ""}
                    </span>
                  </div>
                  <button type="button" {...buttonAttrs("outline", "normal")} onClick={() => navigate(placementDraftPath(placement.id))}>
                    {projectsText("projects.placement.open")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Match>
      </Switch>
    </section>
  )
}
