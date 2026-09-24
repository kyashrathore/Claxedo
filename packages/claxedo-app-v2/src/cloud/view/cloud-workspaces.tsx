import { For, Match, Show, Switch, type Accessor, type Component } from "solid-js"
import { useServer, type PlacementId, type ProjectId } from "@/server"
import { useCloudText } from "../i18n"
import { useCloudWorkspaces } from "../store"
import { CloudWorkspaceItem } from "./cloud-workspace-row"
import { CreateCloudWorkspace } from "./create-cloud-workspace"
import "./cloud.css"

export const CloudWorkspaces: Component<{ projectId: Accessor<ProjectId>; onOpen?: (id: PlacementId) => void }> = (props) => {
  const t = useCloudText()
  const server = useServer()
  const offered = () => server.capabilities()?.features.cloud === true
  const cloud = useCloudWorkspaces(props.projectId, offered)
  const failed = () => {
    const state = cloud.list()
    return state.kind === "failed" ? state.error : undefined
  }
  const rows = () => {
    const state = cloud.list()
    return state.kind === "ready" ? state.rows : undefined
  }

  return (
    <section class="flex flex-col gap-3" aria-label={t("cloud.title")} data-testid="cloud-workspaces">
      <h3 class="m-0 text-sm font-medium">{t("cloud.title")}</h3>
      <Show when={offered()} fallback={<p class="cloud-hint m-0">{t("cloud.unavailable")}</p>}>
        <Switch>
          <Match when={cloud.list().kind === "loading"}>
            <p class="cloud-hint cloud-placeholder m-0">{t("cloud.loading")}</p>
          </Match>
          <Match when={failed()}>
            {(error) => (
              <p class="cloud-alert m-0" role="alert">
                {t("cloud.failed")}: {error().message}
              </p>
            )}
          </Match>
          <Match when={rows()}>
            {(items) => (
              <ul class="m-0 flex list-none flex-col gap-2 p-0">
                <For each={items()} fallback={<li class="cloud-hint">{t("cloud.empty")}</li>}>
                  {(row) => <CloudWorkspaceItem row={row} cloud={cloud} {...(props.onOpen ? { onOpen: props.onOpen } : {})} />}
                </For>
              </ul>
            )}
          </Match>
        </Switch>
        <CreateCloudWorkspace cloud={cloud} />
      </Show>
    </section>
  )
}
