import { For, Show, createMemo, createSignal } from "solid-js"
import { ClaxedoIcon as Icon, type ClaxedoIconProps } from "@/ui/controls/claxedo-icon"
import {
  NavigationRow,
  NavigationRowGlyph,
  NavigationRowStatusGutter,
  NavigationStatusDot,
  type SwitcherStatus,
} from "@/features/session/app-ports"
import {
  type NavigationDragStart,
  type SessionNavigationRow,
} from "./session-navigation"
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
  owner?: SessionNavigationRow["owner"]
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
  const rowsByRef = createMemo(() => new Map(props.rows.map((row) => [row.source.sessionRef, row])))

  return (
    <For each={props.rows.map((row) => row.source.sessionRef)}>
      {(sessionRef) => (
        <SessionNavigationItem
          row={rowsByRef().get(sessionRef)!}
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
  const activate = () => props.onActivate(props.row)
  const owner = createMemo(() => props.row.owner)
  // Nested shared rows: owner mark lives in the absolute glyph column (left-4),
  // same slot as the status dot — not inside the overflow-hidden title flex.
  const ownerInGlyph = createMemo(() => !!props.row.nested && !!owner() && status() === "idle")
  const ownerInline = createMemo(() => !props.row.nested && !!owner())

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
        <Show when={status() !== "idle"} fallback={
          <Show when={ownerInGlyph()}>
            <NavigationRowGlyph>
              <SessionOwnerMark owner={owner()!} />
            </NavigationRowGlyph>
          </Show>
        }>
          <NavigationRowStatusGutter status={status()} />
        </Show>
      </Show>
      <div class="relative z-[1] pointer-events-none flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
        <Show when={ownerInline()}>
          <SessionOwnerMark owner={owner()!} />
        </Show>
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
          <Show when={props.row.nested || status() === "idle"} fallback={
            <NavigationStatusDot status={status()} />
          }>
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
              if (archiving()) return
              setArchiving(true)
              void Promise.resolve(props.onArchive?.(props.row)).finally(() => setArchiving(false))
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

function SessionOwnerMark(props: { owner: NonNullable<SessionNavigationDisplayRow["owner"]> }) {
  const letter = ownerInitials(props.owner.name)
  return (
    <span
      data-testid="rail-sidebar-session-owner-avatar"
      data-slot="session-navigation-owner-avatar"
      class="ui-session-navigation-owner-avatar"
      aria-label={props.owner.name ?? "Session owner"}
      title={props.owner.name ?? "Session owner"}
    >
      {/* SVG text + central baseline: CSS flex still leaves Latin caps optically low. */}
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle cx="8" cy="8" r="8" fill="var(--surface-info-base)" />
        <text
          x="8"
          y="7.6"
          text-anchor="middle"
          dominant-baseline="central"
          fill="#fff"
          font-size="9"
          font-weight="700"
          font-family="ui-sans-serif, system-ui, sans-serif"
        >
          {letter}
        </text>
      </svg>
    </span>
  )
}

function ownerInitials(name: string | undefined) {
  const trimmed = name?.trim()
  if (!trimmed) return "?"
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase()
  return trimmed.slice(0, 1).toUpperCase()
}
