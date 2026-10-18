import { createMemo, Show, type JSX } from "solid-js"
import { sessionId, useServer } from "@/server"
import { useSessionStores } from "@/session"
import type { PanelViewProps } from "@/shell"
import { BackgroundCard } from "./background-card"
import { EnvironmentCard } from "./environment-card"
import { useDetailsText } from "./i18n"

export function SessionDetailsPanel(props: PanelViewProps): JSX.Element {
  const t = useDetailsText()
  const server = useServer()
  const stores = useSessionStores()
  const placement = () => server.placements.byId(props.placementId)
  const view = createMemo(() => {
    const current = placement()
    return current ? stores.open({ projectId: current.projectId, placementId: props.placementId, sessionId: sessionId(props.sessionId) }) : undefined
  })
  return (
    <div
      data-component="session-details"
      data-session-id={props.sessionId}
      role="region"
      aria-label={t("details.label")}
      class="absolute inset-0 flex flex-col gap-2 overflow-y-auto bg-background-base p-3"
    >
      <Show when={placement()}>{(current) => <EnvironmentCard placement={current()} />}</Show>
      <Show when={view()}>{(current) => <BackgroundCard view={current()} />}</Show>
    </div>
  )
}
