import { createSignal, Show, type Component } from "solid-js"
import type { PlacementId } from "@/server"
import { failureReason } from "../api"
import { cloudText } from "../i18n"
import { canStart, canStop, isBusy } from "../model"
import { useCloud, type CloudWorkspaceRow } from "../store"
import { buttonAttrs } from "./button-attrs"
import { cloudStatusText } from "./cloud-status"

export const CloudWorkspaceItem: Component<{ row: CloudWorkspaceRow; onOpen?: (id: PlacementId) => void }> = (props) => {
  const cloud = useCloud()
  const [confirming, setConfirming] = createSignal(false)
  const [deleting, setDeleting] = createSignal(false)
  const [deleteFailure, setDeleteFailure] = createSignal<string>()

  const run = (command: () => Promise<void>) => command().catch(() => undefined)
  const remove = async () => {
    setDeleting(true)
    setDeleteFailure(undefined)
    try {
      await cloud.remove(props.row.id)
    } catch (cause) {
      setDeleteFailure(failureReason(cause))
    } finally {
      setDeleting(false)
      setConfirming(false)
    }
  }

  return (
    <li class="cloud-row" data-workspace-id={props.row.id} data-state={props.row.state.kind}>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-sm font-medium">{props.row.name}</span>
        <Show when={props.row.branch}>{(branch) => <span class="cloud-hint truncate">{branch()}</span>}</Show>
        <Show when={props.row.state.kind === "failed" ? props.row.state : undefined}>
          {(failed) => (
            <span class="cloud-alert" role="alert" data-testid="cloud-failure">
              {failed().kind === "failed" ? failed().reason : ""}
            </span>
          )}
        </Show>
        <Show when={deleteFailure()}>
          {(reason) => (
            <span class="cloud-alert" role="alert">
              {cloudText("cloud.remove.failed")}: {reason()}
            </span>
          )}
        </Show>
      </div>
      <span class="cloud-status" data-kind={props.row.state.kind} aria-busy={isBusy(props.row.state)} data-testid="cloud-status">
        {cloudStatusText(props.row.state)}
      </span>
      <div class="flex flex-wrap gap-2">
        <Show when={props.row.state.kind === "ready" && props.onOpen}>
          {(open) => (
            <button type="button" {...buttonAttrs("contrast", "normal")} onClick={() => open()(props.row.id)}>
              {cloudText("cloud.open")}
            </button>
          )}
        </Show>
        <Show when={canStart(props.row.state)}>
          <button type="button" {...buttonAttrs("outline", "normal")} onClick={() => void run(() => cloud.start(props.row.id))}>
            {cloudText("cloud.start")}
          </button>
        </Show>
        <Show when={canStop(props.row.state)}>
          <button type="button" {...buttonAttrs("outline", "normal")} onClick={() => void run(() => cloud.stop(props.row.id))}>
            {cloudText("cloud.stop")}
          </button>
        </Show>
        <Show
          when={confirming()}
          fallback={
            <button type="button" {...buttonAttrs("ghost-muted", "normal")} disabled={deleting()} onClick={() => setConfirming(true)}>
              {cloudText("cloud.remove.title")}
            </button>
          }
        >
          <span class="cloud-hint self-center">{cloudText("cloud.remove.confirm", { name: props.row.name })}</span>
          <button type="button" {...buttonAttrs("danger", "normal")} disabled={deleting()} onClick={() => void remove()}>
            {cloudText("cloud.remove.button")}
          </button>
          <button type="button" {...buttonAttrs("ghost", "normal")} disabled={deleting()} onClick={() => setConfirming(false)}>
            {cloudText("cloud.cancel")}
          </button>
        </Show>
      </div>
    </li>
  )
}
