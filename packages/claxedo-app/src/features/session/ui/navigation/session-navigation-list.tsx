import { For, Show, createMemo, createSignal } from "solid-js"
import { ClaxedoIcon as Icon, type ClaxedoIconProps } from "@/ui/controls/claxedo-icon"
import { NavigationRow, NavigationRowStatusGutter, NavigationStatusDot, type SwitcherStatus } from "@/features/session/app-ports"
import {
  type NavigationDragStart,
  type SessionNavigationRow,
} from "./session-navigation"

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
  onActivate: (row: SessionNavigationDisplayRow) => void
  onArchive?: (row: SessionNavigationDisplayRow) => void | Promise<void>
  onPrepareDrag: (row: SessionNavigationDisplayRow) => string | undefined
  onDragStart?: (input: NavigationDragStart) => void
}) {
  const status = createMemo(() => props.row.status)
  const [archiving, setArchiving] = createSignal(false)
  const activate = () => props.onActivate(props.row)

  return (
    <div class="group/session">
      <NavigationRow
        data={{
          "data-testid": "rail-sidebar-session-row",
          "data-slot": "session-navigation-row",
          "data-session-id": props.row.source.sessionId,
          "data-session-ref": props.row.source.sessionRef,
          "data-workspace-dir": props.row.directory,
          "data-active": props.row.active ? "true" : "false",
        }}
        classList={{
          "bg-surface-base-hover": props.row.active,
          "pl-9": !!props.row.nested,
          "pl-3": !props.row.nested,
        }}
        label={props.row.title}
        active={props.row.active}
        onActivate={activate}
        dragRow={props.row.source}
        prepareContentId={() => props.onPrepareDrag(props.row)}
        onDragStart={props.onDragStart}
      >
        <Show when={props.row.nested}>
          <NavigationRowStatusGutter status={status()} active={props.row.active} />
        </Show>
        <div class="relative z-[1] pointer-events-none flex items-baseline gap-1.5 flex-1 min-w-0 overflow-hidden">
          <span
            data-slot="session-navigation-title"
            class="text-compact leading-tight truncate flex-1 min-w-0"
            classList={{
              "text-text-strong font-semibold": props.row.active,
              "text-text-weak": !props.row.active,
            }}
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
            class="flex items-center justify-end text-xs tabular-nums group-hover/session:opacity-0 group-focus-within/session:opacity-0 transition-opacity duration-100"
            classList={{
              "text-text-base/70": props.row.active,
              "text-text-weaker": !props.row.active,
            }}
          >
            {/* The timestamp now survives a busy turn: status moved to the
                left gutter (`NavigationRowStatusGutter`), so the two no longer
                compete for this slot. Top-level rows have no gutter to move
                into and keep the old in-place swap. */}
            <Show when={props.row.nested || status() === "idle"} fallback={
              <NavigationStatusDot status={status()} active={props.row.active} />
            }>
              {props.row.timeLabel}
            </Show>
          </span>
          <button
            type="button"
            data-icon-interaction="row-action"
            aria-label={`Archive ${props.row.title}`}
            disabled={archiving()}
            class="absolute inset-0 pointer-events-auto flex items-center justify-end opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100 transition-opacity duration-100 border-none bg-transparent p-0 cursor-pointer disabled:cursor-default"
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
        </div>
      </NavigationRow>
    </div>
  )
}
