import { For, Show, createMemo, createSignal } from "solid-js"
import { ClaxedoIcon as Icon, type ClaxedoIconProps } from "@/ui/controls/claxedo-icon"
import {
  NavigationRow,
  NavigationRowStatusGutter,
  NavigationStatusDot,
  type SwitcherStatus,
} from "@/features/session/app-ports"
import { type NavigationDragStart, type SessionNavigationRow } from "./session-navigation"
import "./session-navigation-list.css"

export type SessionNavigationDisplayRow = {
  source: SessionNavigationRow
  title: string
  directory: string
  active: boolean
  nested?: boolean
  status: SwitcherStatus
  timeLabel?: string
  metadata?: {
    icon: ClaxedoIconProps["name"]
    label: string
  }
}

export type SessionNavigationProps = {
  rows: readonly SessionNavigationDisplayRow[]
  onPrepareActivate?: (row: SessionNavigationDisplayRow) => void
  onActivate: (row: SessionNavigationDisplayRow) => void
  onArchive?: (row: SessionNavigationDisplayRow) => void | Promise<void>
  onPrepareDrag: (row: SessionNavigationDisplayRow) => string | undefined
  onDragStart?: (input: NavigationDragStart) => void
}

export function SessionNavigation(props: SessionNavigationProps) {
  // Rows are keyed by SESSION ID, not by the encoded sessionRef. The ref is a
  // transport projection that changes form when canonical workspace backing
  // arrives (see sameRailSessionActivationTarget) — keying the <For> on it
  // recreated the row's DOM at exactly that moment, detaching the activate
  // button mid-interaction (the harness's trusted-click pointerdown listener
  // died with it). A session appears at most once per navigation section, so
  // the id is a stable, unique key; the row's CONTENT still updates reactively
  // through the id-keyed lookup.
  const rowsById = createMemo(() => new Map(props.rows.map((row) => [row.source.sessionId, row])))

  return (
    <For each={props.rows.map((row) => row.source.sessionId)}>
      {(sessionId) => (
        <SessionNavigationItem
          row={rowsById().get(sessionId)!}
          onPrepareActivate={props.onPrepareActivate}
          onActivate={props.onActivate}
          onArchive={props.onArchive}
          onPrepareDrag={props.onPrepareDrag}
          onDragStart={props.onDragStart}
        />
      )}
    </For>
  )
}

function SessionNavigationItem(props: {
  row: SessionNavigationDisplayRow
  onPrepareActivate?: (row: SessionNavigationDisplayRow) => void
  onActivate: (row: SessionNavigationDisplayRow) => void
  onArchive?: (row: SessionNavigationDisplayRow) => void | Promise<void>
  onPrepareDrag: (row: SessionNavigationDisplayRow) => string | undefined
  onDragStart?: (input: NavigationDragStart) => void
}) {
  const status = createMemo(() => props.row.status)
  const [archiving, setArchiving] = createSignal(false)
  const [engaged, setEngaged] = createSignal(false)
  let archiveInFlight = false
  const activate = () => props.onActivate(props.row)

  return (
    <NavigationRow
      onEngagedChange={setEngaged}
      data={{
        "data-testid": "rail-sidebar-session-row",
        "data-slot": "session-navigation-row",
        "data-session-id": props.row.source.sessionId,
        "data-session-ref": props.row.source.sessionRef,
        "data-workspace-dir": props.row.directory,
      }}
      classList={{
        "pl-9": !!props.row.nested,
        "pl-3": !props.row.nested,
      }}
      label={props.row.title}
      active={props.row.active}
      onPrepareActivate={() => props.onPrepareActivate?.(props.row)}
      onActivate={activate}
      dragRow={props.row.source}
      prepareContentId={() => props.onPrepareDrag(props.row)}
      onDragStart={props.onDragStart}
    >
      <Show when={props.row.nested}>
        <NavigationRowStatusGutter status={status()} />
      </Show>
      <div class="relative z-[1] pointer-events-none flex items-baseline gap-1.5 flex-1 min-w-0 overflow-hidden">
        <span
          data-slot="session-navigation-title"
          class="ui-session-navigation-title text-compact leading-tight truncate flex-1 min-w-0"
        >
          {props.row.title}
        </span>
        <Show when={props.row.metadata}>
          {(metadata) => (
            <span
              data-icon-interaction="passive"
              role="img"
              aria-label={metadata().label}
              title={metadata().label}
              class="shrink-0 text-icon-weak-base/80 leading-none"
            >
              <Icon name={metadata().icon} size="small" />
            </span>
          )}
        </Show>
      </div>

      {/* z-10: sit above NavigationRow's absolute activate overlay so the
          archive button stays clickable and isn't a nested interactive. */}
      <div class="size-6 shrink-0 relative z-10 flex items-center justify-end self-stretch">
        <span
          data-slot="session-navigation-time"
          class="ui-session-navigation-time flex items-center justify-end text-xs tabular-nums"
        >
          {/* The timestamp now survives a busy turn: status moved to the
              left gutter (`NavigationRowStatusGutter`), so the two no longer
              compete for this slot. Top-level rows have no gutter to move
              into and keep the old in-place swap. */}
          <Show when={props.row.nested || status() === "idle"} fallback={<NavigationStatusDot status={status()} />}>
            {props.row.timeLabel}
          </Show>
        </span>
        {/* Hover/focus only, and MOUNTED that way rather than parked behind
            `opacity: 0`. The button is `absolute inset-0` inside this fixed
            `size-6` box, so mounting it changes no layout — it just stops
            five elements per row from being walked by every whole-document
            style recalculation while it is invisible. It stays mounted while
            an archive is in flight so the pointer may leave mid-request. */}
        <Show when={engaged() || archiving()}>
          <button
            type="button"
            data-icon-interaction="row-action"
            data-slot="session-navigation-archive"
            aria-label={`Archive ${props.row.title}`}
            disabled={archiving()}
            class="ui-session-navigation-archive absolute inset-0 pointer-events-auto flex items-center justify-end border-none bg-transparent p-0 cursor-pointer disabled:cursor-default"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              // Same-task re-entrancy guard: the signal read lags staged
              // writes until commit, so a plain flag owns the guard and the
              // signal only drives the disabled state.
              if (archiveInFlight) return
              archiveInFlight = true
              setArchiving(true)
              void Promise.resolve(props.onArchive?.(props.row)).finally(() => {
                archiveInFlight = false
                setArchiving(false)
              })
            }}
          >
            <span class="flex items-center leading-none text-icon-weak-base hover:text-icon-base transition-colors cursor-pointer">
              <Icon name="archive" size="small" />
            </span>
          </button>
        </Show>
      </div>
    </NavigationRow>
  )
}
