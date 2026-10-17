import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useAgeClock } from "@/lib/clock"
import type { SessionRowView } from "@/session"
import { useShellLayout } from "@/shell"
import { createHoverEngagement, type HoverEngagement } from "../hover-engagement"
import { navigationStatus, sessionAge, sessionAgeSince } from "../model"
import type { SessionMarker } from "../session-marker"
import { NavigationRow, NavigationStatusMark } from "./navigation-row"
import { SessionMarkerIcon } from "./session-marker-icon"
import { SessionRowMenu, type SessionRowMenuActions } from "./session-row-menu"
import { SettleButton } from "./settle-button"
import "../session-navigation.css"

export type SessionRowProps = SessionRowMenuActions & {
  readonly row: SessionRowView
  readonly marker: SessionMarker | undefined
  readonly projectLabel: string
  readonly caption?: string
  readonly active: boolean
  readonly onActivate: (row: SessionRowView) => void
  readonly prepareDrag?: () => string | undefined
}

const MARQUEE_MS_PER_PIXEL = 28

function SessionTitle(props: { readonly title: string; readonly hovered: boolean }): JSX.Element {
  let clip: HTMLSpanElement | undefined
  const overflow = createMemo(() => (props.hovered && props.title && clip ? Math.max(0, clip.scrollWidth - clip.clientWidth) : 0))
  return (
    <span
      ref={clip}
      data-marquee={overflow() > 0 ? "true" : undefined}
      class="ui-session-navigation-title ui-session-title leading-tight flex-1 min-w-0"
      style={{ "--session-title-distance": `${overflow()}px`, "--session-title-duration": `${overflow() * MARQUEE_MS_PER_PIXEL}ms` }}
    >
      <span class="ui-session-title-text">{props.title}</span>
    </span>
  )
}

function SessionRowAge(props: { readonly row: SessionRowView }): JSX.Element {
  const now = useAgeClock(() => sessionAgeSince(props.row))
  return <span class="ui-session-navigation-meta shrink-0 text-xs leading-4 tabular-nums">{sessionAge(props.row, now())}</span>
}

type SessionLineProps = Pick<SessionRowProps, "row" | "marker" | "projectLabel" | "onToggleSettled"> & {
  readonly engagement: HoverEngagement
  readonly coarsePointer: boolean
}

function SessionLine(props: SessionLineProps): JSX.Element {
  const status = () => navigationStatus(props.row)
  const revealed = () => props.engagement.engaged() || props.coarsePointer
  return (
    <div class="relative flex min-w-0 items-center gap-1">
      <Show when={status() !== "idle"}>
        <span class="absolute right-full top-1/2 mr-1 flex size-4 -translate-y-1/2 items-center justify-center">
          <NavigationStatusMark status={status()} />
        </span>
      </Show>
      <SessionTitle title={props.row.title} hovered={props.engagement.hovered()} />
      <Show when={!props.engagement.engaged() || props.coarsePointer}>
        <SessionRowAge row={props.row} />
      </Show>
      <Show when={revealed() && props.marker}>
        {(marker) => <SessionMarkerIcon marker={marker()} projectLabel={props.projectLabel} />}
      </Show>
      <Show when={revealed()}>
        <SettleButton row={props.row} touch={props.coarsePointer} onToggleSettled={props.onToggleSettled} />
      </Show>
    </div>
  )
}

export function RailSessionRow(props: SessionRowProps): JSX.Element {
  const [menu, setMenu] = createSignal<{ x: number; y: number }>()
  const engagement = createHoverEngagement()
  const layout = useShellLayout()
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
      <div class="relative z-[1] pointer-events-none flex flex-col gap-0.5 flex-1 min-w-0 py-1.5">
        <SessionLine row={props.row} marker={props.marker} projectLabel={props.projectLabel} onToggleSettled={props.onToggleSettled} engagement={engagement} coarsePointer={layout.coarsePointer()} />
        <Show when={props.caption}>
          {(caption) => <span class="ui-session-navigation-meta min-w-0 truncate text-xs leading-4">{caption()}</span>}
        </Show>
      </div>
      <Show when={menu()}>
        {(at) => <SessionRowMenu at={at()} row={props.row} onRename={props.onRename} onToggleSettled={props.onToggleSettled} onDismiss={() => setMenu(undefined)} />}
      </Show>
    </NavigationRow>
  )
}
