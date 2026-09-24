import { createEffect, createMemo, createSignal, on, Show, untrack, type Accessor, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { SessionList, SessionRowView } from "@/session"
import type { TerminalItem } from "@/terminal"
import { dictionary } from "../i18n"
import { railRows, SESSION_GROUP_PAGE_SIZE, type SessionMarker } from "../model"
import type { ProjectSection } from "../project-sections"
import { ProjectHeader } from "./project-header"
import { ProjectRows } from "./project-rows"
import { SessionListNotice } from "./session-list-notice"
import type { SessionRowMenuActions } from "./session-row-menu"
import { useProjectTerminals } from "./terminal-row"

export type ProjectBlockProps = SessionRowMenuActions & {
  readonly section: ProjectSection
  readonly rows: readonly SessionRowView[]
  readonly active: boolean
  readonly activeSessionId: string | undefined
  readonly activeTerminalId: string | undefined
  readonly now: Accessor<number>
  readonly list: SessionList
  readonly onSelect: (section: ProjectSection) => void
  readonly onNewTerminal: (section: ProjectSection) => void
  readonly onActivate: (row: SessionRowView) => void
  readonly markerOf: (row: SessionRowView) => SessionMarker | undefined
}

function createProjectPaging(props: ProjectBlockProps) {
  const [visible, setVisible] = createSignal(SESSION_GROUP_PAGE_SIZE)
  const loaded = () => props.list.state().kind === "live" || props.list.state().kind === "rereading"
  const shown = createMemo(() => props.rows.slice(0, visible()))
  const more = () => props.rows.length > visible() || (props.list.hasMore() && props.rows.length >= visible())
  return {
    shown,
    more,
    loadingMore: () => props.list.moreState().kind === "loading",
    pageError: () => props.list.moreState().kind === "failed",
    loadingInitial: () => !loaded() && props.list.state().kind !== "failed" && props.rows.length === 0,
    errorInitial: () => props.list.state().kind === "failed",
    emptyLoaded: () => loaded() && props.rows.length === 0,
    doneLoaded: () => loaded() && props.rows.length > SESSION_GROUP_PAGE_SIZE && !more(),
    loadMore: () => {
      const next = visible() + SESSION_GROUP_PAGE_SIZE
      setVisible(next)
      if (props.rows.length < next && props.list.hasMore()) void props.list.loadMore()
    },
  }
}

function LoadMore(props: { readonly loading: boolean; readonly onLoad: () => void }): JSX.Element {
  const t = useTranslator(dictionary)
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
  const t = useTranslator(dictionary)
  return (
    <div class="flex flex-col gap-0.5 pb-1">
      <ProjectRows
        rows={railRows(props.terminals, props.paging.shown())}
        activeSessionId={props.activeSessionId}
        activeTerminalId={props.activeTerminalId}
        markerOf={props.markerOf}
        projectLabel={props.section.label}
        now={props.now}
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
        <LoadMore loading={props.paging.loadingMore()} onLoad={props.paging.loadMore} />
      </Show>
      <Show when={props.paging.pageError()}>
        <SessionListNotice variant="error" actionLabel={t("rail.retry")} onAction={props.paging.loadMore}>
          {t("rail.loadMoreFailed")}
        </SessionListNotice>
      </Show>
      <Show when={props.paging.doneLoaded()}>
        <SessionListNotice variant="done">{t("rail.allLoaded")}</SessionListNotice>
      </Show>
    </div>
  )
}

export function ProjectBlock(props: ProjectBlockProps): JSX.Element {
  const [open, setOpen] = createSignal(props.rows.length > 0 || props.active)
  const [toggled, setToggled] = createSignal(false)
  const paging = createProjectPaging(props)
  const terminals = useProjectTerminals(() => props.section.placementIds)
  createEffect(on(() => props.active, (active) => active && setOpen(true)))
  createEffect(on(() => terminals().length > 0, (has) => has && setOpen(true)))
  createEffect(on(() => props.rows.length > 0, (has) => has && !untrack(toggled) && setOpen(true)))
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
