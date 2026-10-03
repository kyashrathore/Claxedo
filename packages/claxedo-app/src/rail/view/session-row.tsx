import { SettleSessionButton } from "./settle-session-button"
import { SessionNavigationTitle } from "./session-navigation-title"
import { createSignal, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useAgeClock } from "@/lib/clock"
import { type SessionRowView } from "@/session"
import { createHoverEngagement } from "../hover-engagement"
import { railDictionary } from "../i18n"
import { navigationStatus, sessionAge, sessionAgeSince, type SessionMarker } from "../model"
import { NavigationRow, NavigationRowStatusGutter } from "./navigation-row"
import { SessionRowMenu, type SessionRowMenuActions } from "./session-row-menu"
import "../session-navigation.css"
import { ClaxedoIcon as Icon } from "@/ui"

export type SessionRowProps = SessionRowMenuActions & {
  readonly row: SessionRowView
  readonly marker: SessionMarker | undefined
  readonly projectLabel: string
  readonly active: boolean
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

export function RailSessionRow(props: SessionRowProps): JSX.Element {
  const [menu, setMenu] = createSignal<{ x: number; y: number }>()
  const engagement = createHoverEngagement()
  const status = () => navigationStatus(props.row)
  const now = useAgeClock(() => sessionAgeSince(props.row))
  const openMenu = (event: MouseEvent) => {
    event.preventDefault()
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.querySelector<HTMLButtonElement>('[data-slot="navigation-row-activate"]')?.focus()
    setMenu({ x: event.clientX, y: event.clientY })
  }
  return (
    <NavigationRow
      data={{ "data-testid": "rail-sidebar-session-row", "data-slot": "session-navigation-row", "data-session-id": props.row.ref.sessionId }}
      class="pl-7"
      label={props.row.title}
      active={props.active}
      onActivate={() => props.onActivate(props.row)}
      onContextMenu={openMenu}
      onKeyboardMenu={setMenu}
      engagement={engagement}
      prepareDrag={props.prepareDrag}
    >
      <NavigationRowStatusGutter status={status()} />
      <div class="relative z-[1] pointer-events-none flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
        <SessionNavigationTitle value={props.row.title} engagement={engagement} class="ui-session-navigation-title leading-tight" />
        <Show when={props.marker}>{(marker) => <MarkerIcon marker={marker()} projectLabel={props.projectLabel} />}</Show>
      </div>
      <div class="ui-session-navigation-actions shrink-0 relative z-10 flex items-center justify-end self-stretch">
        <span class="ui-session-navigation-time flex items-center justify-end text-xs tabular-nums">
          {sessionAge(props.row, now())}
        </span>
      </div>
      <span class="ui-session-navigation-settle"><SettleSessionButton row={props.row} compact onToggleSettled={props.onToggleSettled} /></span>
      <Show when={menu()}>
        {(at) => <SessionRowMenu at={at()} row={props.row} onRename={props.onRename} onToggleSettled={props.onToggleSettled} onDismiss={() => setMenu(undefined)} />}
      </Show>
    </NavigationRow>
  )
}
