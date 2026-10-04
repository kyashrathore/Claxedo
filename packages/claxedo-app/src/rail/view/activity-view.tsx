import { createMemo, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useProjectList } from "@/projects"
import { ACTIVITY_WINDOW, matchesActivityFilter, useSessionStores, type ActivityFilter } from "@/session"
import { railDictionary } from "../i18n"
import { SESSION_GROUP_PAGE_SIZE, sessionRowKey } from "../model"
import { createRowNavigation } from "./row-navigation"
import { createSessionActions } from "./session-actions"
import { SessionListNotice, SessionLoadMore, SessionRowsLoading } from "./session-list-notice"
import { RailSessionRow } from "./session-row"

function ActivityNotices(props: { readonly count: number }): JSX.Element {
  const t = useTranslator(railDictionary)
  const list = useSessionStores().list
  const more = () => list.moreState(ACTIVITY_WINDOW)
  const reading = () => more().kind === "loading" || list.state().kind === "subscribing" || list.state().kind === "fetching"
  const failed = () => list.state().kind === "failed" || list.pageFailure(ACTIVITY_WINDOW) !== undefined
  const loaded = () => !reading() && !failed()
  return (
    <>
      <Show when={props.count === 0 && reading()}>
        <SessionRowsLoading />
      </Show>
      <Show when={failed()}>
        <SessionListNotice variant="error" actionLabel={t("rail.retry")} onAction={() => void list.reload()}>{t("rail.loadFailed")}</SessionListNotice>
      </Show>
      <Show when={props.count === 0 && loaded()}>
        <SessionListNotice variant="empty">{t("rail.activity.empty")}</SessionListNotice>
      </Show>
      <Show when={list.hasMore(ACTIVITY_WINDOW)}>
        <SessionLoadMore loading={more().kind === "loading"} onLoad={() => void list.loadMore(ACTIVITY_WINDOW)} />
      </Show>
      <Show when={more().kind === "failed"}>
        <SessionListNotice variant="error" actionLabel={t("rail.retry")} onAction={() => void list.loadMore(ACTIVITY_WINDOW)}>{t("rail.loadMoreFailed")}</SessionListNotice>
      </Show>
      <Show when={list.pageDegraded(ACTIVITY_WINDOW)}>
        <SessionListNotice variant="error" actionLabel={t("rail.retry")} onAction={() => void list.reload()}>{t("rail.partialLoad")}</SessionListNotice>
      </Show>
      <Show when={loaded() && props.count > SESSION_GROUP_PAGE_SIZE && !list.hasMore(ACTIVITY_WINDOW)}>
        <SessionListNotice variant="done">{t("rail.allLoaded")}</SessionListNotice>
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
      <ActivityNotices count={sessionIds().length} />
    </div>
  )
}
