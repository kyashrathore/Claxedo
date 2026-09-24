import { createVirtualizer } from "@tanstack/solid-virtual"
import { Index, type JSX } from "solid-js"
import type { SessionId } from "@/server"
import type { SessionRowView } from "@/session"
import type { SessionActions } from "./session-actions"
import { SESSION_ROW_HEIGHT, SessionRow } from "./session-row"

export function SessionRows(props: {
  readonly rows: readonly SessionRowView[]
  readonly activeSessionId: SessionId | undefined
  readonly actions: SessionActions
}): JSX.Element {
  let scrollElement: HTMLDivElement | undefined
  const virtualizer = createVirtualizer({
    get count() {
      return props.rows.length
    },
    getScrollElement: () => scrollElement ?? null,
    estimateSize: () => SESSION_ROW_HEIGHT,
    overscan: 12,
  })
  return (
    <div ref={scrollElement} class="rail-scroll" data-testid="session-list">
      <ul role="list" class="rail-rows" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        <Index each={virtualizer.getVirtualItems()}>
          {(item) => (
            <SessionRow
              row={props.rows[item().index]}
              active={props.rows[item().index].ref.sessionId === props.activeSessionId}
              top={item().start}
              actions={props.actions}
            />
          )}
        </Index>
      </ul>
    </div>
  )
}
