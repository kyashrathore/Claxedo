import { createSignal, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useAgeClock } from "@/lib/clock"
import { canSettle, type SessionRowView } from "@/session"
import { useShellLayout } from "@/shell"
import { createHoverEngagement } from "../hover-engagement"
import { railDictionary } from "../i18n"
import { navigationStatus, sessionAge, sessionAgeSince, type SessionMarker } from "../model"
import { NavigationRow, NavigationRowStatusGutter } from "./navigation-row"
import { SessionRowMenu, type SessionRowMenuActions } from "./session-row-menu"
import { SessionTitle } from "./session-title"
import "../session-navigation.css"
import { ClaxedoIcon as Icon } from "@/ui"

export type SessionRowProps = SessionRowMenuActions & {
  readonly row: SessionRowView
  readonly marker: SessionMarker | undefined
  readonly projectLabel: string
  readonly caption?: string
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

function SettleButton(props: { readonly row: SessionRowView; readonly onToggleSettled: (row: SessionRowView) => Promise<void> }): JSX.Element {
  const t = useTranslator(railDictionary)
  const [busy, setBusy] = createSignal(false)
  return (
    <button
      type="button"
      data-icon-interaction="row-action"
      aria-label={t(props.row.settled ? "rail.returnSession" : "rail.settleSession", { title: props.row.title })}
      title={t(props.row.settled ? "rail.returnToActive" : "rail.settle")}
      disabled={busy() || !canSettle(props.row)}
      class="ui-session-navigation-settle absolute inset-0 pointer-events-auto flex items-center justify-end border-none bg-transparent p-0 cursor-pointer disabled:cursor-default disabled:opacity-40"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        setBusy(true)
        void props.onToggleSettled(props.row).finally(() => setBusy(false))
      }}
    >
      <span class="flex items-center leading-none text-icon-weak-base hover:text-icon-base transition-colors">
        <Icon name={props.row.settled ? "reset" : "check"} size="small" />
      </span>
    </button>
  )
}

export function RailSessionRow(props: SessionRowProps): JSX.Element {
  const [menu, setMenu] = createSignal<{ x: number; y: number }>()
  const engagement = createHoverEngagement()
  const layout = useShellLayout()
  const status = () => navigationStatus(props.row)
  const now = useAgeClock(() => sessionAgeSince(props.row))
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
        <SessionTitle title={props.row.title} hovered={engagement.hovered()} />
        <Show when={props.caption}>{(caption) => <span class="ui-session-navigation-caption shrink-0 max-w-[40%] truncate text-xs">{caption()}</span>}</Show>
        <Show when={props.marker}>{(marker) => <MarkerIcon marker={marker()} projectLabel={props.projectLabel} />}</Show>
      </div>
      <div class="size-6 shrink-0 relative z-10 flex items-center justify-end self-stretch">
        <span class="ui-session-navigation-time flex items-center justify-end text-xs tabular-nums">
          {sessionAge(props.row, now())}
        </span>
        <Show when={engagement.engaged() || layout.phone()}>
          <SettleButton row={props.row} onToggleSettled={props.onToggleSettled} />
        </Show>
      </div>
      <Show when={menu()}>
        {(at) => <SessionRowMenu at={at()} row={props.row} onRename={props.onRename} onToggleSettled={props.onToggleSettled} onDismiss={() => setMenu(undefined)} />}
      </Show>
    </NavigationRow>
  )
}
