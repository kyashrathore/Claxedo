import { createSignal, Show, type Component } from "solid-js"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, type PlacementId } from "@/server"
import { Button } from "@opencode-ai/ui/button"
import { useCloudText } from "../i18n"
import { canStart, canStop, failureOf, isBusy } from "../model"
import type { CloudWorkspaceRow, CloudWorkspaces } from "../store"
import { cloudStatusText } from "./cloud-status"

export const CloudWorkspaceItem: Component<{
  row: CloudWorkspaceRow
  cloud: CloudWorkspaces
  onOpen?: (id: PlacementId) => void
}> = (props) => {
  const t = useCloudText()
  const [confirming, setConfirming] = createSignal(false)
  const removal = createFlow<"deleting", void>()
  const deleting = () => removal.state().kind === "running"

  const remove = async () => {
    await runFlow(removal, "deleting", () => props.cloud.remove(props.row.id), toAppError)
    setConfirming(false)
  }

  return (
    <li class="cloud-row" data-workspace-id={props.row.id} data-state={props.row.state.kind}>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-sm font-medium">{props.row.name}</span>
        <Show when={props.row.branch}>{(branch) => <span class="cloud-hint truncate">{branch()}</span>}</Show>
        <Show when={failureOf(props.row.state)}>
          {(reason) => (
            <span class="cloud-alert" role="alert" data-testid="cloud-failure">
              {reason()}
            </span>
          )}
        </Show>
      </div>
      <span class="cloud-status" data-kind={props.row.state.kind} aria-busy={isBusy(props.row.state)} data-testid="cloud-status">
        {cloudStatusText(t, props.row.state)}
      </span>
      <div class="flex flex-wrap gap-2">
        <Show when={props.row.state.kind === "ready" ? props.onOpen : undefined}>
          {(open) => (
            <Button variant="primary" onClick={() => open()(props.row.id)}>
              {t("cloud.open")}
            </Button>
          )}
        </Show>
        <Show when={canStart(props.row.state)}>
          <Button variant="secondary" onClick={() => void props.cloud.start(props.row.id)}>
            {t("cloud.start")}
          </Button>
        </Show>
        <Show when={canStop(props.row.state)}>
          <Button variant="secondary" onClick={() => void props.cloud.stop(props.row.id)}>
            {t("cloud.stop")}
          </Button>
        </Show>
        <Show
          when={confirming()}
          fallback={
            <Button variant="ghost" disabled={deleting()} onClick={() => setConfirming(true)}>
              {t("cloud.remove.title")}
            </Button>
          }
        >
          <span class="cloud-hint self-center">{t("cloud.remove.confirm", { name: props.row.name })}</span>
          <Button variant="primary" disabled={deleting()} onClick={() => void remove()}>
            {deleting() ? t("cloud.deleting") : t("cloud.remove.button")}
          </Button>
          <Button variant="ghost" disabled={deleting()} onClick={() => setConfirming(false)}>
            {t("cloud.cancel")}
          </Button>
        </Show>
      </div>
    </li>
  )
}
