import { Show } from "solid-js"
import { isStoppedCloud, useServer, type PlacementId, type WorkspaceStartProgress } from "@/server"
import { ClaxedoIcon, Spinner } from "@/ui"
import { useSessionScreenText, type SessionScreenText } from "../text"

function wakingDetail(t: SessionScreenText, progress: WorkspaceStartProgress) {
  if (progress.bootMode === "restore") return t("sessionScreen.workspace.restoring")
  if (progress.bootMode === "resume") return t("sessionScreen.workspace.resuming")
  return undefined
}

export function WorkspaceSleepCard(props: { readonly placementId: PlacementId }) {
  const t = useSessionScreenText()
  const server = useServer()
  const waking = () => server.cloud.waking(props.placementId)
  const asleep = () => isStoppedCloud(server.placements.byId(props.placementId))
  return (
    <Show when={waking() || asleep()}>
      <div role="status" aria-live="polite" class="mb-2 flex items-center gap-2 rounded-md border border-border-weak-base/60 bg-background-base px-3 py-2 text-13-regular text-text-weak">
        <Show
          when={waking()}
          fallback={
            <>
              <ClaxedoIcon name="circle-alert" size="small" class="shrink-0 text-icon-weak-base" />
              <span>{t("sessionScreen.workspace.asleep")}</span>
            </>
          }
        >
          {(progress) => (
            <>
              <Spinner class="size-4 shrink-0" />
              <span>{t("sessionScreen.workspace.waking")}</span>
              <Show when={wakingDetail(t, progress())}>{(detail) => <span class="text-text-weaker">{detail()}</span>}</Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}
