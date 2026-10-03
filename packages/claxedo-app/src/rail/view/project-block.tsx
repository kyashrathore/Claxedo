import { createEffect, createMemo, createSignal, on, Show, untrack, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { SessionId } from "@/server"
import type { SessionList, SessionRowView } from "@/session"
import type { TerminalItem } from "@/terminal"
import { railDictionary } from "../i18n"
import { SESSION_GROUP_PAGE_SIZE, type RailRow, type SessionMarker } from "../model"
import type { ProjectSection } from "../project-sections"
import { ProjectHeader } from "./project-header"
import { ProjectRows } from "./project-rows"
import { SessionListNotice } from "./session-list-notice"
import type { SessionRowMenuActions } from "./session-row-menu"
import { useProjectTerminals } from "./terminal-row"

export type ProjectBlockProps = SessionRowMenuActions & {
  readonly section: ProjectSection
  readonly sessionIds: readonly SessionId[]
  readonly active: boolean
  readonly activeSessionId: string | undefined
  readonly activeTerminalId: string | undefined
  readonly list: SessionList
  readonly onSelect: (section: ProjectSection) => void
  readonly onNewTerminal: (section: ProjectSection) => void
  readonly onActivate: (row: SessionRowView) => void
  readonly markerOf: (row: SessionRowView) => SessionMarker | undefined
  readonly prepareDrag: (row: RailRow) => string | undefined
}

function createProjectPaging(props: ProjectBlockProps) {
  const [visible, setVisible] = createSignal(SESSION_GROUP_PAGE_SIZE)
  const loaded = () => props.list.state().kind === "live" || props.list.state().kind === "rereading"
  const shown = createMemo(() => props.sessionIds.slice(0, visible()))
  const projectId = () => props.section.projectId
  const hasMore = () => props.list.hasMore(projectId())
  const more = () => props.sessionIds.length > visible() || hasMore()
  const failed = () => props.list.state().kind === "failed" || props.list.pageFailure(projectId()) !== undefined
  return {
    shown,
    more,
    loadingMore: () => props.list.moreState(projectId()).kind === "loading",
    pageError: () => props.list.moreState(projectId()).kind === "failed",
    degraded: () => loaded() && props.list.pageDegraded(projectId()),
    loadingInitial: () => !loaded() && !failed() && props.sessionIds.length === 0,
    errorInitial: () => failed() && props.sessionIds.length === 0,
    emptyLoaded: () => loaded() && !failed() && props.sessionIds.length === 0,
    doneLoaded: () => loaded() && props.sessionIds.length > SESSION_GROUP_PAGE_SIZE && !more(),
    loadMore: () => {
      const next = visible() + SESSION_GROUP_PAGE_SIZE
      setVisible(next)
      if (props.sessionIds.length < next && hasMore()) void props.list.loadMore(projectId())
    },
  }
}

function SessionLoadMore(props: { readonly loading: boolean; readonly onLoad: () => void }): JSX.Element {
  const t = useTranslator(railDictionary)
  return (
    <button
      data-testid="rail-sidebar-session-load-more"
      type="button"
      class="text-sm text-text-weaker hover:text-text-weak pl-9 pr-2.5 py-1 text-left transition-colors duration-100"
      disabled={props.loading}
      classList={{ "opacity-60": props.loading }}
      onClick={(event) => {
        props.onLoad()
        event.currentTarget.blur()
      }}
    >
      {props.loading ? t("rail.loadingMore") : t("rail.loadMore")}
    </button>
  )
}

function ProjectSessions(
  props: ProjectBlockProps & { readonly paging: ReturnType<typeof createProjectPaging>; readonly terminals: readonly TerminalItem[] },
): JSX.Element {
  const t = useTranslator(railDictionary)
  return (
    <div class="flex flex-col gap-0.5 pb-1">
      <ProjectRows
        terminals={props.terminals}
        sessionIds={props.paging.shown()}
        list={props.list}
        activeSessionId={props.activeSessionId}
        activeTerminalId={props.activeTerminalId}
        markerOf={props.markerOf}
        prepareDrag={props.prepareDrag}
        projectLabel={props.section.label}
        onActivate={props.onActivate}
        onRename={props.onRename}
        onArchive={props.onArchive}
        onDelete={props.onDelete}
      />
      <Show when={props.paging.loadingInitial()}>
        <SessionListNotice variant="loading">{t("rail.loadingSessions")}</SessionListNotice>
      </Show>
      <Show when={props.paging.errorInitial()}>
        <SessionListNotice variant="error" actionLabel={t("rail.retry")} onAction={() => void props.list.reload()}>
          {t("rail.loadFailed")}
        </SessionListNotice>
      </Show>
      <Show when={props.paging.emptyLoaded()}>
        <SessionListNotice variant="empty">{t("rail.noMatches")}</SessionListNotice>
      </Show>
      <Show when={props.paging.more()}>
        <SessionLoadMore loading={props.paging.loadingMore()} onLoad={props.paging.loadMore} />
      </Show>
      <Show when={props.paging.pageError()}>
        <SessionListNotice variant="error" actionLabel={t("rail.retry")} onAction={props.paging.loadMore}>
          {t("rail.loadMoreFailed")}
        </SessionListNotice>
      </Show>
      <Show when={props.paging.degraded()}>
        <SessionListNotice variant="error" actionLabel={t("rail.retry")} onAction={() => void props.list.reload()}>
          {t("rail.partialLoad")}
        </SessionListNotice>
      </Show>
      <Show when={props.paging.doneLoaded()}>
        <SessionListNotice variant="done">{t("rail.allLoaded")}</SessionListNotice>
      </Show>
    </div>
  )
}

export function ProjectBlock(props: ProjectBlockProps): JSX.Element {
  const [open, setOpen] = createSignal(props.sessionIds.length > 0 || props.active)
  const [toggled, setToggled] = createSignal(false)
  const paging = createProjectPaging(props)
  const terminals = useProjectTerminals(() => props.section.placementIds, open)
  createEffect(on(() => props.active, (active) => active && setOpen(true)))
  createEffect(on(() => props.sessionIds.length > 0, (has) => has && !untrack(toggled) && setOpen(true)))
  return (
    <div data-testid="project-group" data-project-id={props.section.projectId} class="flex flex-col gap-0.5">
      <ProjectHeader
        section={props.section}
        open={open()}
        active={props.active}
        onToggle={() => {
          setToggled(true)
          setOpen(!open())
        }}
        onSelect={() => {
          setOpen(true)
          props.onSelect(props.section)
        }}
        onNewSession={() => props.onSelect(props.section)}
        onNewTerminal={() => props.onNewTerminal(props.section)}
      />
      <Show when={open()}>
        <ProjectSessions {...props} paging={paging} terminals={terminals()} />
      </Show>
    </div>
  )
}
