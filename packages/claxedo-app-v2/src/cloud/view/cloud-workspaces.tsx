import { For, Match, Show, Switch, type Accessor, type Component } from "solid-js"
import type { PlacementId, ProjectId } from "@/server"
import { useCloudServer } from "../api"
import { cloudText } from "../i18n"
import { useCloud } from "../store"
import { CloudWorkspaceItem } from "./cloud-workspace-row"
import { CreateCloudWorkspace } from "./create-cloud-workspace"
import "./cloud.css"

export const CloudWorkspaces: Component<{ projectId: Accessor<ProjectId>; onOpen?: (id: PlacementId) => void }> = (props) => {
  const server = useCloudServer()
  const cloud = useCloud()
  const offered = () => server.capabilities()?.features.cloud === true
  const list = cloud.workspacesOf(props.projectId)
  const failed = () => {
    const state = list()
    return state.kind === "failed" ? state.error : undefined
  }
  const rows = () => {
    const state = list()
    return state.kind === "ready" ? state.rows : undefined
  }

  return (
    <section class="flex flex-col gap-3" aria-label={cloudText("cloud.title")} data-testid="cloud-workspaces">
      <h3 class="m-0 text-sm font-medium">{cloudText("cloud.title")}</h3>
      <Show when={offered()} fallback={<p class="cloud-hint m-0">{cloudText("cloud.unavailable")}</p>}>
        <Switch>
          <Match when={list().kind === "loading"}>
            <p class="cloud-hint cloud-placeholder m-0">{cloudText("cloud.loading")}</p>
          </Match>
          <Match when={failed()}>
            {(error) => (
              <p class="cloud-alert m-0" role="alert">
                {cloudText("cloud.failed")}: {error().message}
              </p>
            )}
          </Match>
          <Match when={rows()}>
            {(items) => (
              <ul class="m-0 flex list-none flex-col gap-2 p-0">
                <For each={items()} fallback={<li class="cloud-hint">{cloudText("cloud.empty")}</li>}>
                  {(row) => <CloudWorkspaceItem row={row} {...(props.onOpen ? { onOpen: props.onOpen } : {})} />}
                </For>
              </ul>
            )}
          </Match>
        </Switch>
        <CreateCloudWorkspace projectId={props.projectId()} />
      </Show>
    </section>
  )
}
