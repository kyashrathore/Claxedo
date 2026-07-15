import type { ChangeCursor } from "@claxedo/workgraph/contracts"
import { WorkGraphApiError } from "./api"

// A bounded long-poll window. The server holds each /changes request open up to
// this long — its own 30s ceiling — and returns the instant a change lands, so a
// timed-out empty poll re-issues the next request immediately without any
// client-side timer standing in for the server's blocking wait.
export const WORKGRAPH_CHANGE_WAIT_MS = 25_000

// The single response shape the synchronizer reads from a /changes poll — the
// ordered change window (only its size matters here), the cursor to advance to,
// and whether the poll timed out. The real client's `changes` satisfies this.
export type ChangeWindow = { changes: readonly unknown[]; cursor?: ChangeCursor; timedOut: boolean }
export type WorkGraphChangesPoll = (
  cursor: ChangeCursor | undefined,
  options: Readonly<{ waitMs: number; signal: AbortSignal }>,
) => Promise<ChangeWindow>

// The single WorkGraph live synchronizer. Seeded at the canonical snapshot
// cursor, it continuously long-polls /changes: each ordered change window is
// applied exactly once by reloading the canonical snapshot and Attention, then
// the returned cursor advances so that same window is never reapplied. A
// cursor_invalid response performs exactly one canonical reset and resumes from
// the reset snapshot's cursor. Any other failure stalls the loop and surfaces the
// error verbatim for an explicit, user-initiated retry — never a silent fallback
// snapshot. Aborting the signal (unmount/navigation) stops the loop and cancels
// the in-flight poll.
export async function runWorkGraphSync(input: {
  changes: WorkGraphChangesPoll
  cursor: ChangeCursor | undefined
  signal: AbortSignal
  waitMs: number
  // Reloads the canonical snapshot and Attention, returning the fresh snapshot
  // cursor — used both to apply a change window and to reset after cursor_invalid.
  reload: () => Promise<ChangeCursor | undefined>
  onAdvance: (cursor: ChangeCursor | undefined) => void
  onError: (error: WorkGraphApiError) => void
}) {
  // A canonical reload that fails is itself an ordinary stall: surface it and stop
  // the loop for an explicit retry rather than looping on a broken snapshot.
  const applyReload = async (): Promise<{ cursor: ChangeCursor | undefined } | undefined> => {
    try {
      return { cursor: await input.reload() }
    } catch (error) {
      if (!input.signal.aborted) input.onError(toApiError(error))
      return undefined
    }
  }

  let cursor = input.cursor
  while (!input.signal.aborted) {
    let result: ChangeWindow
    try {
      result = await input.changes(cursor, { waitMs: input.waitMs, signal: input.signal })
    } catch (error) {
      if (input.signal.aborted) return
      if (error instanceof WorkGraphApiError && error.kind === "cursor_invalid") {
        const reset = await applyReload()
        if (!reset || input.signal.aborted) return
        cursor = reset.cursor
        input.onAdvance(cursor)
        continue
      }
      input.onError(toApiError(error))
      return
    }
    if (input.signal.aborted) return
    if (result.changes.length > 0) {
      const applied = await applyReload()
      if (!applied || input.signal.aborted) return
      cursor = result.cursor ?? cursor
      input.onAdvance(cursor)
      continue
    }
    // A timed-out empty poll: advance to the echoed cursor and re-issue the next
    // bounded long-poll. The server, not a client timer, paces this loop.
    cursor = result.cursor ?? cursor
    input.onAdvance(cursor)
  }
}

function toApiError(error: unknown) {
  return error instanceof WorkGraphApiError
    ? error
    : new WorkGraphApiError("request_failed", error instanceof Error ? error.message : String(error))
}
