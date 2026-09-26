import { Show } from "solid-js"
import { isOfflineMachine, useServer, type PlacementId } from "@/server"
import { ClaxedoIcon } from "@/ui"
import { useSessionScreenText } from "../text"

const CARD = "mb-2 flex items-center gap-2 rounded-md border border-border-weak-base/60 bg-background-base px-3 py-2 text-13-regular text-text-weak"

export function MachineOfflineCard(props: { readonly placementId: PlacementId }) {
  const t = useSessionScreenText()
  const server = useServer()
  const offline = () => isOfflineMachine(server.placements.byId(props.placementId), server.capabilities()?.thisMachine?.id)
  return (
    <Show when={offline()}>
      <div role="status" class={CARD}>
        <ClaxedoIcon name="circle-alert" size="small" class="shrink-0 text-icon-weak-base" />
        <span>{t("sessionScreen.workspace.machineOffline")}</span>
      </div>
    </Show>
  )
}
