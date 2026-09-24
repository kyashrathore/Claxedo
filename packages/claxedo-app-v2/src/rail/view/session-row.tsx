import { createSignal, Show, type Accessor, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { SessionRowView } from "@/session"
import { createHoverEngagement } from "../hover-engagement"
import { railDictionary } from "../i18n"
import { navigationStatus, sessionAge, type SessionMarker } from "../model"
import { NavigationRow, NavigationRowStatusGutter } from "./navigation-row"
import { SessionRowMenu, type SessionRowMenuActions } from "./session-row-menu"
import "../session-navigation.css"
import { ClaxedoIcon as Icon } from "@/ui"

export type SessionRowProps = SessionRowMenuActions & {
  readonly row: SessionRowView
  readonly marker: SessionMarker | undefined
  readonly projectLabel: string
  readonly active: boolean
  readonly now: Accessor<number>
  readonly onActivate: (row: SessionRowView) => void
  readonly prepareDrag?: () => string | undefined
}

const MARKER_ICON = { cloud: "cloud", machine: "server", worktree: "worktree" } as const

function MarkerIcon(props: { readonly marker: SessionMarker; readonly projectLabel: string }): JSX.Element {
  const t = useTranslator(railDictionary)
  const label = () => {
    const { kind, name, path } = props.marker
    if (kind === "cloud") return `${t("rail.marker.cloud")} · ${name}`
    if (kind === "machine") return `${t("rail.marker.machine")} · ${name}`
    const base = t("rail.marker.worktree", { project: props.projectLabel, name })
    return path && path !== name ? `${base} · ${path}` : base
  }
  return (
    <span data-icon-interaction="passive" role="img" aria-label={label()} title={label()} class="shrink-0 text-icon-weak-base/80 leading-none">
      <Icon name={MARKER_ICON[props.marker.kind]} size="small" />
    </span>
  )
}

function ArchiveButton(props: { readonly row: SessionRowView; readonly engaged: boolean; readonly onArchive: (row: SessionRowView) => Promise<void> }): JSX.Element {
  const t = useTranslator(railDictionary)
  const [archiving, setArchiving] = createSignal(false)
  return (
    <Show when={props.engaged || archiving()}>
      <button
        type="button"
        data-icon-interaction="row-action"
        data-slot="session-navigation-archive"
        aria-label={t("rail.archiveSession", { title: props.row.title })}
        disabled={archiving()}
        class="ui-session-navigation-archive absolute inset-0 pointer-events-auto flex items-center justify-end border-none bg-transparent p-0 cursor-pointer disabled:cursor-default"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          if (archiving()) return
          setArchiving(true)
          void props.onArchive(props.row).finally(() => setArchiving(false))
        }}
      >
        <span class="flex items-center leading-none text-icon-weak-base hover:text-icon-base transition-colors cursor-pointer">
          <Icon name="archive" size="small" />
        </span>
      </button>
    </Show>
  )
}

export function SessionRow(props: SessionRowProps): JSX.Element {
  const [menu, setMenu] = createSignal<{ x: number; y: number }>()
  const engagement = createHoverEngagement()
  const status = () => navigationStatus(props.row)
  const openMenu = (event: MouseEvent) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }
  return (
    <NavigationRow
      data={{ "data-testid": "rail-sidebar-session-row", "data-slot": "session-navigation-row", "data-session-id": props.row.ref.sessionId }}
      classList={{ "pl-9": true }}
      label={props.row.title}
      active={props.active}
      onActivate={() => props.onActivate(props.row)}
      onContextMenu={openMenu}
      engagement={engagement}
      prepareDrag={props.prepareDrag}
    >
      <NavigationRowStatusGutter status={status()} />
      <div class="relative z-[1] pointer-events-none flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
        <span data-slot="session-navigation-title" class="ui-session-navigation-title text-compact leading-tight truncate flex-1 min-w-0">
          {props.row.title}
        </span>
        <Show when={props.marker}>{(marker) => <MarkerIcon marker={marker()} projectLabel={props.projectLabel} />}</Show>
      </div>
      <div class="size-6 shrink-0 relative z-10 flex items-center justify-end self-stretch">
        <span data-slot="session-navigation-time" class="ui-session-navigation-time flex items-center justify-end text-xs tabular-nums">
          {sessionAge(props.row, props.now())}
        </span>
        <ArchiveButton row={props.row} engaged={engagement.engaged()} onArchive={props.onArchive} />
      </div>
      <Show when={menu()}>
        {(at) => <SessionRowMenu at={at()} row={props.row} onRename={props.onRename} onArchive={props.onArchive} onDelete={props.onDelete} onDismiss={() => setMenu(undefined)} />}
      </Show>
    </NavigationRow>
  )
}
