import { For, Match, Switch, type Accessor, type Component } from "solid-js"
import { unreachable } from "@/lib/machine"
import type { Placement, ProjectId } from "@/server"
import { Button } from "@opencode-ai/ui/button"
import { useProjectsText, type ProjectsText } from "../i18n"
import { usePlacementOpener } from "../open"
import { useProjectPlacements } from "../store"

export function placementKindLabel(t: ProjectsText, placement: Placement): string {
  switch (placement.kind) {
    case "folder":
      return t("projects.placement.folder")
    case "worktree":
      return t("projects.placement.worktree")
    case "cloud":
      return t("projects.placement.cloud")
    default:
      return unreachable(placement.kind)
  }
}

function placementDetail(t: ProjectsText, placement: Placement): string {
  return [placementKindLabel(t, placement), placement.path, placement.branch].filter(Boolean).join(" · ")
}

export const PlacementList: Component<{ projectId: Accessor<ProjectId> }> = (props) => {
  const t = useProjectsText()
  const placements = useProjectPlacements(props.projectId)
  const open = usePlacementOpener()
  const local = () => {
    const state = placements()
    return state.kind === "ready" ? state.data.filter((placement) => placement.kind !== "cloud") : []
  }
  const failed = () => {
    const state = placements()
    return state.kind === "failed" ? state.error : undefined
  }

  return (
    <div class="flex flex-col gap-2" data-testid="placements">
      <Switch>
        <Match when={placements().kind === "loading"}>
          <p class="projects-hint projects-placeholder m-0">{t("projects.loading")}</p>
        </Match>
        <Match when={failed()}>
          {(error) => (
            <p class="projects-alert m-0" role="alert">
              {error().message}
            </p>
          )}
        </Match>
        <Match when={placements().kind === "ready"}>
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            <For each={local()} fallback={<li class="projects-hint">{t("projects.placements.empty")}</li>}>
              {(placement) => (
                <li class="projects-placement" data-placement-id={placement.id}>
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm">{placement.label}</span>
                    <span class="projects-hint truncate">{placementDetail(t, placement)}</span>
                  </div>
                  <Button variant="secondary" size="small" onClick={() => open(placement.id)}>
                    {t("projects.placement.open")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Match>
      </Switch>
    </div>
  )
}
