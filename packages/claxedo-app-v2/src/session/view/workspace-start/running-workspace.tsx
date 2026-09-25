import { Show, type ParentProps } from "solid-js"
import { isStoppedCloud, useServer, type PlacementId } from "@/server"
import { createWorkspaceStart } from "./start-workspace"
import { WorkspaceStartView } from "./workspace-start-view"

export function RunningWorkspace(props: ParentProps<{ readonly placementId: PlacementId }>) {
  const server = useServer()
  const stopped = () => isStoppedCloud(server.placements.byId(props.placementId))
  const workspace = createWorkspaceStart(server, () => props.placementId)
  return (
    <Show when={stopped()} fallback={props.children}>
      <div class="w-full rounded-md border border-border-weak-base/60 bg-background-base px-5 py-4">
        <WorkspaceStartView start={workspace} />
      </div>
    </Show>
  )
}
