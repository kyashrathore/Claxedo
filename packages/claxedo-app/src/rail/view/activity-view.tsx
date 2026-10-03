import { createEffect, Show, type Accessor, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { useSessionStores, type SessionRowView } from "@/session"
import { ClaxedoIcon } from "@/ui"
import { railDictionary } from "../i18n"
import { activityPlacement } from "../activity-placement"
import { ActivityRow } from "./activity-row"
import { ActivityRows } from "./activity-rows"
import { createSessionActions } from "./session-actions"

export function ActivityView(): JSX.Element {
  const t = useTranslator(railDictionary)
  const server = useServer()
  const inventory = useSessionStores().list.inventory
  const actions = createSessionActions()
  const page = inventory.window
  const problem = () => page().kind === "failed" ? t("rail.loadFailed") : page().degraded ? t("rail.activity.incomplete") : undefined
  createEffect(() => { void inventory.load() })
  const row = (row: Accessor<SessionRowView>) => {
    const detail = () => activityPlacement(row(), server.capabilities()?.thisMachine?.id, t("rail.placementUnavailable"))
    return <ActivityRow row={row()} projectName={row().projectName ?? t("rail.projectUnavailable")} placementName={detail().name} placementIcon={detail().icon} {...actions} />
  }
  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="activity-sidebar">
      <Show when={problem()}>{(message) => <div role="status" class="ui-activity-problem flex shrink-0 items-center gap-1.5 px-4 text-xs text-text-weak"><ClaxedoIcon name="circle-alert" size="small" /><span>{message()}</span><button type="button" class="min-h-11 shrink-0" onClick={() => void inventory.reload()}>{t("rail.retry")}</button></div>}</Show>
      <ActivityRows row={row} page={page} sessionIds={inventory.rows().map((ref) => ref.sessionId)} />
    </div>
  )
}
