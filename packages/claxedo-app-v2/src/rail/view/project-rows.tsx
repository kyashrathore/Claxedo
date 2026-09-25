import { createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import type { SessionId } from "@/server"
import type { SessionList, SessionRowView } from "@/session"
import type { TerminalItem } from "@/terminal"
import { sessionRowKey, terminalRowKey, type RailRow, type SessionMarker } from "../model"
import { RailSessionRow } from "./session-row"
import type { SessionRowMenuActions } from "./session-row-menu"
import { RailTerminalRow } from "./terminal-row"

export type ProjectRowsProps = SessionRowMenuActions & {
  readonly terminals: readonly TerminalItem[]
  readonly sessionIds: readonly SessionId[]
  readonly list: SessionList
  readonly activeSessionId: string | undefined
  readonly activeTerminalId: string | undefined
  readonly now: Accessor<number>
  readonly onActivate: (row: SessionRowView) => void
  readonly markerOf: (row: SessionRowView) => SessionMarker | undefined
  readonly projectLabel: string
  readonly prepareDrag: (row: RailRow) => string | undefined
}

function TerminalRows(props: ProjectRowsProps): JSX.Element {
  const byKey = createMemo(() => new Map(props.terminals.map((terminal) => [terminalRowKey(terminal), terminal])))
  return (
    <For each={props.terminals.map(terminalRowKey)}>
      {(key) => (
        <Show when={byKey().get(key)}>
          {(terminal) => (
            <RailTerminalRow
              row={terminal()}
              active={props.activeTerminalId === terminal().terminalId}
              prepareDrag={() => props.prepareDrag({ kind: "terminal", key, terminal: terminal() })}
            />
          )}
        </Show>
      )}
    </For>
  )
}

function SessionRows(props: ProjectRowsProps): JSX.Element {
  return (
    <For each={props.sessionIds}>
      {(sessionId) => (
        <Show when={props.list.view(sessionId)}>
          {(session) => (
            <RailSessionRow
              row={session()}
              marker={props.markerOf(session())}
              projectLabel={props.projectLabel}
              active={props.activeSessionId === sessionId}
              now={props.now}
              onActivate={props.onActivate}
              onRename={props.onRename}
              onArchive={props.onArchive}
              onDelete={props.onDelete}
              prepareDrag={() => props.prepareDrag({ kind: "session", key: sessionRowKey(sessionId), session: session() })}
            />
          )}
        </Show>
      )}
    </For>
  )
}

export function ProjectRows(props: ProjectRowsProps): JSX.Element {
  return (
    <>
      <TerminalRows {...props} />
      <SessionRows {...props} />
    </>
  )
}
