import { safeStartIndex } from "./replay-safe-slice"
import { sanitizeReplay } from "./replay-sanitize"

// Keep this small enough to avoid localStorage quota issues (which can
// permanently disable persistence in some browsers once it starts failing).
// Terminal history should primarily be restored from the PTY stream, not from
// multi-megabyte localStorage blobs.
export const MAX_RESTORE_BUFFER_BYTES = 256 * 1024
export const MAX_PERSIST_BUFFER_BYTES = 256 * 1024

/**
 * Ceiling on the COMBINED persisted snapshots in one workspace's terminal store.
 *
 * `MAX_PERSIST_BUFFER_BYTES` bounds one snapshot; nothing bounded their sum.
 * The terminal list grows by creation and shrinks only on `pty.deleted`, so
 * twenty terminals in a single workspace persist up to 5.1 MB — past the ~5 MB
 * localStorage origin budget on their own, which is exactly the failure the
 * per-buffer cap was introduced to avoid ("can permanently disable persistence
 * in some browsers once it starts failing"). When it trips, the casualties are
 * every other persisted key sharing that origin, not just terminal history.
 *
 * 1 MiB holds four full-size snapshots, or many more ordinary ones, and leaves
 * the rest of the origin budget to the other stores. Dropping a snapshot is not
 * data loss: the terminal restores from the PTY stream instead, which the cap
 * above already names as where history should primarily come from.
 *
 * Bounds ONE workspace's store. The origin-wide total across workspaces is
 * still unbounded — each workspace persists under its own key, and nothing
 * coordinates between them. Narrowing that needs a cross-store budget.
 */
export const MAX_PERSIST_BUFFER_BUDGET_BYTES = 1024 * 1024

/**
 * Which terminals must give up their persisted snapshot for the store to fit
 * inside {@link MAX_PERSIST_BUFFER_BUDGET_BYTES}, oldest first.
 *
 * `keep` is the terminal whose snapshot was just written and the active one:
 * evicting either would throw away the history most likely to be restored next,
 * which is the whole point of persisting it. Terminals carrying no snapshot are
 * skipped — they free nothing.
 */
export function pickPersistBufferEvictions(input: {
  terminals: ReadonlyArray<{ id: string; buffer?: string }>
  keep: ReadonlyArray<string | undefined>
  budget?: number
}) {
  const budget = input.budget ?? MAX_PERSIST_BUFFER_BUDGET_BYTES
  let total = input.terminals.reduce((sum, item) => sum + (item.buffer?.length ?? 0), 0)
  if (total <= budget) return []
  const keep = new Set(input.keep.filter((id): id is string => !!id))
  const stale: string[] = []
  for (const terminal of input.terminals) {
    if (total <= budget) break
    const size = terminal.buffer?.length ?? 0
    if (size === 0 || keep.has(terminal.id)) continue
    stale.push(terminal.id)
    total -= size
  }
  return stale
}

/**
 * Trim to the last `max` code units, moving the cut to a safe boundary so the
 * kept tail never starts mid-escape (which xterm prints as literal junk) or on
 * a lone surrogate.
 */
function keepTail(value: string, max: number) {
  if (value.length <= max) return value
  return value.slice(safeStartIndex(value, value.length - max))
}

export function prepareRestoreBuffer(value?: string) {
  if (!value) return { value: undefined, trimmed: false }
  // Sanitize on the way OUT as well as in, so snapshots persisted by an older
  // build (which still contain the program's queries and mode sets) cannot
  // re-arm mouse tracking or provoke an answer-back into a shell that never
  // asked. Cheap: a no-op for any buffer without an ESC.
  const clean = sanitizeReplay(value)
  if (clean.length <= MAX_RESTORE_BUFFER_BYTES) return { value: clean, trimmed: false }
  return { value: keepTail(clean, MAX_RESTORE_BUFFER_BYTES), trimmed: true }
}

export function preparePersistBuffer(value: string) {
  if (!value) return value
  // A persisted snapshot is a RECORDING. Strip the sequences that only make
  // sense live — terminal queries (which the next mount would answer into a
  // pty whose program has moved on) and mode sets (which belong to the live
  // preamble from the PTY host, not to a transcript).
  return keepTail(sanitizeReplay(value), MAX_PERSIST_BUFFER_BYTES)
}
