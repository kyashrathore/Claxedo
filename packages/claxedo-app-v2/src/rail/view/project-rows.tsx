import { createMemo, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js"
import type { SessionRowView } from "@/session"
import type { RailRow, SessionMarker } from "../model"
import { RailSessionRow } from "./session-row"
import type { SessionRowMenuActions } from "./session-row-menu"
import { RailTerminalRow } from "./terminal-row"

export type ProjectRowsProps = SessionRowMenuActions & {
  readonly rows: readonly RailRow[]
  readonly activeSessionId: string | undefined
  readonly activeTerminalId: string | undefined
  readonly now: Accessor<number>
  readonly onActivate: (row: SessionRowView) => void
  readonly markerOf: (row: SessionRowView) => SessionMarker | undefined
  readonly projectLabel: string
  readonly prepareDrag: (row: RailRow) => string | undefined
}

function Row(props: ProjectRowsProps & { readonly row: RailRow }): JSX.Element {
  return (
    <Switch>
      <Match when={props.row.kind === "terminal" ? props.row.terminal : undefined}>
        {(terminal) => <RailTerminalRow row={terminal()} active={props.activeTerminalId === terminal().terminalId} prepareDrag={() => props.prepareDrag(props.row)} />}
      </Match>
      <Match when={props.row.kind === "session" ? props.row.session : undefined}>
        {(session) => (
          <RailSessionRow
            row={session()}
            marker={props.markerOf(session())}
            projectLabel={props.projectLabel}
            active={props.activeSessionId === session().ref.sessionId}
            now={props.now}
            onActivate={props.onActivate}
            onRename={props.onRename}
            onArchive={props.onArchive}
            onDelete={props.onDelete}
            prepareDrag={() => props.prepareDrag(props.row)}
          />
        )}
      </Match>
    </Switch>
  )
}

export function ProjectRows(props: ProjectRowsProps): JSX.Element {
  const byKey = createMemo(() => new Map(props.rows.map((row) => [row.key, row])))
  return (
    <For each={props.rows.map((row) => row.key)}>
      {(key) => <Show when={byKey().get(key)}>{(row) => <Row {...props} row={row()} />}</Show>}
    </For>
  )
}
