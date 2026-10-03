import { createEffect, createMemo, on, Show, type Accessor, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { useSessionStores, type SessionRowView } from "@/session"
import { ClaxedoIcon } from "@/ui"
import { activityPlacement } from "../activity-placement"
import { railDictionary } from "../i18n"
import { ActivityRow } from "./activity-row"
import { SessionNavigationRows } from "./session-navigation-rows"
import { createSessionActions } from "./session-actions"

export function SharedSessionsSection(props: { readonly scroller: Accessor<HTMLElement | undefined>; readonly geometry: Accessor<number> }): JSX.Element {
  const server = useServer()
  const inventory = useSessionStores().list.inventory
  const t = useTranslator(railDictionary)
  const actions = createSessionActions()
  const page = () => inventory.sharedWindow()
  const rows = createMemo(() => inventory.sharedRows())
  const sessionIds = createMemo(() => rows().map((ref) => ref.sessionId))
  const refresh = () => void server.sharedSessions.refresh().then(() => inventory.loadShared()).catch((error: unknown) => console.error("Shared sessions could not be refreshed", { error }))
  createEffect(on(() => server.sharedSessions.enabled, (enabled) => { if (enabled) void inventory.loadShared() }))
  const row = (row: Accessor<SessionRowView>) => {
    const placement = () => activityPlacement(row(), server.capabilities()?.thisMachine?.id, t("rail.placementUnavailable"))
    const share = () => server.sharedSessions.find(row().ref)
    return <div data-testid="shared-session-row" data-session-id={row().ref.sessionId}><ActivityRow row={row()} projectName={row().projectName ?? t("rail.projectUnavailable")} placementIcon={placement().icon} placementName={placement().name} {...actions} /><Show when={share()}>{(access) => <p class="h-5 truncate pl-14 text-xs text-text-weak">{t(`rail.shared.${access().level}`, { owner: access().ownerName ?? "" })}</p>}</Show></div>
  }
  return <Show when={server.sharedSessions.enabled && (page().count > 0 || page().kind === "failed" || server.sharedSessions.error())}>
    <section data-testid="shared-sessions" aria-label={t("rail.shared")} class="flex flex-col px-2 py-2">
      <div class="flex min-h-11 items-center justify-between px-2">
        <h2 class="sidebar-section-label">{t("rail.shared")}</h2>
        <button type="button" aria-label={t("rail.shared.refresh")} class="flex size-11 items-center justify-center rounded text-icon-weak-base hover:text-icon-base" onClick={refresh}><ClaxedoIcon name="reset" size="small" /></button>
      </div>
      <Show when={page().kind === "failed" || server.sharedSessions.error()}><p role="alert" class="px-2 text-xs text-text-weak">{t("rail.shared.failed")}</p></Show>
      <Show when={page().degraded}><p role="status" class="px-2 text-xs text-text-weak">{t("rail.activity.incomplete")}</p></Show>
      <SessionNavigationRows {...props} sessionIds={sessionIds()} row={row} rowSize={88} />
      <Show when={page().after}><button type="button" disabled={page().kind === "loading"} class="min-h-11 px-2 text-left text-xs text-text-weak" onClick={() => void inventory.moreShared()}>{t("rail.loadMore")}</button></Show>
    </section>
  </Show>
}
