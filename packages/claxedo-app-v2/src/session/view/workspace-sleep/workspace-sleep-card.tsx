import { Match, Show, Switch } from "solid-js"
import { useServer, type PlacementId, type WorkspaceBootMode } from "@/server"
import { Button, ClaxedoIcon, Spinner } from "@/ui"
import { useSessionScreenText, type SessionScreenText } from "../text"

function bootDetail(t: SessionScreenText, bootMode: WorkspaceBootMode | undefined) {
  if (bootMode === "restore") return t("sessionScreen.workspace.restoring")
  if (bootMode === "resume") return t("sessionScreen.workspace.resuming")
  return undefined
}

const CARD = "mb-2 flex items-center gap-2 rounded-md border border-border-weak-base/60 bg-background-base px-3 py-2 text-13-regular text-text-weak"

export function WorkspaceSleepCard(props: { readonly placementId: PlacementId }) {
  const t = useSessionScreenText()
  const server = useServer()
  const runtime = () => server.cloud.runtime(props.placementId)
  const waking = () => {
    const current = runtime()
    return current.kind === "waking" ? current : undefined
  }
  const failed = () => {
    const current = runtime()
    return current.kind === "wakeFailed" ? current : undefined
  }
  const retry = () =>
    server.cloud.start(props.placementId).catch((error: unknown) => console.warn("The workspace could not be woken", { placementId: props.placementId, error }))
  return (
    <Switch>
      <Match when={runtime().kind === "asleep"}>
        <div role="status" class={CARD}>
          <ClaxedoIcon name="circle-alert" size="small" class="shrink-0 text-icon-weak-base" />
          <span>{t("sessionScreen.workspace.asleep")}</span>
        </div>
      </Match>
      <Match when={waking()}>
        {(current) => (
          <div role="status" aria-live="polite" class={CARD}>
            <Spinner class="size-4 shrink-0" />
            <span>{t("sessionScreen.workspace.waking")}</span>
            <Show when={bootDetail(t, current().bootMode)}>{(detail) => <span class="text-text-weaker">{detail()}</span>}</Show>
          </div>
        )}
      </Match>
      <Match when={failed()}>
        {(current) => (
          <div role="alert" class={CARD}>
            <ClaxedoIcon name="warning" size="small" class="shrink-0 text-icon-base" />
            <span class="min-w-0 flex-1 text-text-base">
              {t("sessionScreen.workspace.wakeFailed")} <span class="text-text-weak">{current().error.message}</span>
            </span>
            <Button variant="secondary" size="small" onClick={() => void retry()}>
              {t("sessionScreen.workspace.retryWake")}
            </Button>
          </div>
        )}
      </Match>
    </Switch>
  )
}
