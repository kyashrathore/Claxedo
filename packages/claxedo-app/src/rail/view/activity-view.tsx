import { createMemo, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useProjectList } from "@/projects"
import { ACTIVITY_WINDOW, matchesActivityFilter, useSessionStores, type ActivityFilter } from "@/session"
import { railDictionary } from "../i18n"
import { sessionRowKey } from "../model"
import { createRowNavigation } from "./row-navigation"
import { createSessionActions } from "./session-actions"
import { SessionListNotice } from "./session-list-notice"
import { RailSessionRow } from "./session-row"

function ActivityNotices(props: { readonly empty: boolean }): JSX.Element {
  const t = useTranslator(railDictionary)
  const list = useSessionStores().list
  const reading = () => list.moreState(ACTIVITY_WINDOW).kind === "loading" || list.state().kind === "subscribing" || list.state().kind === "fetching"
  const failed = () => list.state().kind === "failed" || list.pageFailure(ACTIVITY_WINDOW) !== undefined || list.moreState(ACTIVITY_WINDOW).kind === "failed"
  return (
    <>
      <Show when={props.empty && reading()}>
        <SessionListNotice variant="loading">{t("rail.loadingSessions")}</SessionListNotice>
      </Show>
      <Show when={failed()}>
        <SessionListNotice variant="error" actionLabel={t("rail.retry")} onAction={() => void list.reload()}>{t("rail.loadFailed")}</SessionListNotice>
      </Show>
      <Show when={list.pageDegraded(ACTIVITY_WINDOW)}>
        <SessionListNotice variant="error" actionLabel={t("rail.retry")} onAction={() => void list.reload()}>{t("rail.partialLoad")}</SessionListNotice>
      </Show>
      <Show when={props.empty && !reading() && !failed()}>
        <SessionListNotice variant="empty">{t("rail.activity.empty")}</SessionListNotice>
      </Show>
      <Show when={list.hasMore(ACTIVITY_WINDOW)}>
        <button
          type="button"
          data-testid="rail-sidebar-session-load-more"
          class="text-sm text-text-weaker hover:text-text-weak pl-9 pr-2.5 py-1 text-left max-md:min-h-11"
          disabled={list.moreState(ACTIVITY_WINDOW).kind === "loading"}
          onClick={() => void list.loadMore(ACTIVITY_WINDOW)}
        >
          {list.moreState(ACTIVITY_WINDOW).kind === "loading" ? t("rail.loadingMore") : t("rail.loadMore")}
        </button>
      </Show>
    </>
  )
}

export function ActivityView(props: { readonly filter: ActivityFilter }): JSX.Element {
  const list = useSessionStores().list
  const projects = useProjectList()
  const actions = createSessionActions()
  const navigation = createRowNavigation()
  const projectNames = createMemo(() => new Map(projects.list().map((entry) => [entry.project.id, entry.project.name])))
  const sessionIds = createMemo(() =>
    list.activityOrder().flatMap((ref) => {
      const row = props.filter === "all" ? undefined : list.view(ref.sessionId)
      return props.filter === "all" || (row && matchesActivityFilter(row, props.filter)) ? [ref.sessionId] : []
    }),
  )
  return (
    <div data-testid="activity-sessions" class="flex-1 flex flex-col py-1.5 gap-0.5">
      <For each={sessionIds()}>
        {(sessionId) => (
          <Show when={list.view(sessionId)}>
            {(row) => (
              <RailSessionRow
                row={row()}
                marker={navigation.markerOf(row())}
                projectLabel={projectNames().get(row().ref.projectId) ?? ""}
                caption={projectNames().get(row().ref.projectId)}
                active={navigation.activeSessionId() === sessionId}
                onActivate={navigation.open}
                onRename={actions.onRename}
                onToggleSettled={actions.onToggleSettled}
                prepareDrag={() => navigation.prepareDrag({ kind: "session", key: sessionRowKey(sessionId), session: row() })}
              />
            )}
          </Show>
        )}
      </For>
      <ActivityNotices empty={sessionIds().length === 0} />
    </div>
  )
}
