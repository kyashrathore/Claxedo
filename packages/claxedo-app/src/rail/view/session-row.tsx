import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useTranslator, type DomainTranslate } from "@/i18n"
import { useAgeClock } from "@/lib/clock"
import { canSettle, type SessionRowView } from "@/session"
import { useShellLayout } from "@/shell"
import { createHoverEngagement } from "../hover-engagement"
import { railDictionary, type RailKey } from "../i18n"
import { navigationStatus, sessionAge, sessionAgeSince, type SessionMarker } from "../model"
import { NavigationRow, NavigationRowStatusGutter } from "./navigation-row"
import { SessionRowMenu, type SessionRowMenuActions } from "./session-row-menu"
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

const MARKER_ICON = { cloud: "cloud", machine: "server", worktree: "worktree" } as const

function markerLabel(t: DomainTranslate<RailKey>, marker: SessionMarker, projectLabel: string): string {
  if (marker.kind === "cloud") return `${t("rail.marker.cloud")} · ${marker.name}`
  if (marker.kind === "machine") return t("rail.marker.machine", { folder: marker.folder, machine: marker.name })
  const base = t("rail.marker.worktree", { project: projectLabel, name: marker.name })
  return marker.path && marker.path !== marker.name ? `${base} · ${marker.path}` : base
}

function SessionRowMeta(props: { readonly row: SessionRowView; readonly marker: SessionMarker | undefined; readonly projectLabel: string; readonly caption?: string }): JSX.Element {
  const t = useTranslator(railDictionary)
  const now = useAgeClock(() => sessionAgeSince(props.row))
  return (
    <span class="ui-session-navigation-meta flex min-w-0 items-center gap-1 text-xs leading-4">
      <Show when={props.caption}>
        {(caption) => <span class="min-w-0 shrink truncate">{caption()}</span>}
      </Show>
      <Show when={props.marker}>
        {(marker) => (
          <span role="img" aria-label={markerLabel(t, marker(), props.projectLabel)} title={markerLabel(t, marker(), props.projectLabel)} class="flex min-w-0 shrink items-center gap-1">
            <Show when={props.caption}><span aria-hidden="true">·</span></Show>
            <Icon name={MARKER_ICON[marker().kind]} size="small" class="size-3 shrink-0" />
            <span class="min-w-0 truncate" aria-hidden="true">{marker().name}</span>
          </span>
        )}
      </Show>
      <Show when={props.caption || props.marker}><span aria-hidden="true">·</span></Show>
      <span class="shrink-0 tabular-nums">{sessionAge(props.row, now())}</span>
    </span>
  )
}

function SettleButton(props: { readonly row: SessionRowView; readonly touch: boolean; readonly onToggleSettled: (row: SessionRowView) => Promise<void> }): JSX.Element {
  const t = useTranslator(railDictionary)
  const [busy, setBusy] = createSignal(false)
  return (
    <button
      type="button"
      data-icon-interaction="row-action"
      aria-label={t(props.row.settled ? "rail.returnSession" : "rail.settleSession", { title: props.row.title })}
      title={t(props.row.settled ? "rail.returnToActive" : "rail.settle")}
      disabled={busy() || !canSettle(props.row)}
      class="pointer-events-auto flex items-center justify-end border-none bg-transparent p-0 cursor-pointer disabled:cursor-default disabled:opacity-40"
      classList={{ "ui-session-navigation-settle-touch z-10 size-6 shrink-0": props.touch, "absolute inset-0": !props.touch }}
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
      <div class="relative z-[1] pointer-events-none flex flex-col gap-0.5 flex-1 min-w-0 overflow-hidden py-1.5">
        <SessionTitle title={props.row.title} hovered={engagement.hovered()} />
        <SessionRowMeta row={props.row} marker={props.marker} projectLabel={props.projectLabel} caption={props.caption} />
      </div>
      <div class="size-6 shrink-0 relative z-10 flex items-center justify-end self-start mt-1">
        <Show when={engagement.engaged() && !layout.coarsePointer()}>
          <SettleButton row={props.row} touch={false} onToggleSettled={props.onToggleSettled} />
        </Show>
      </div>
      <Show when={layout.coarsePointer()}>
        <SettleButton row={props.row} touch onToggleSettled={props.onToggleSettled} />
      </Show>
      <Show when={menu()}>
        {(at) => <SessionRowMenu at={at()} row={props.row} onRename={props.onRename} onToggleSettled={props.onToggleSettled} onDismiss={() => setMenu(undefined)} />}
      </Show>
    </NavigationRow>
  )
}
