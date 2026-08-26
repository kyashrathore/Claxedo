import { createSignal, type Accessor } from "solid-js"

// History-pagination bookkeeping for a session's message backfill. Each field is
// keyed by `sessionHistoryKey(directory, sessionID)`:
//   - limit:        how many messages the current fold has hydrated (undefined = never hydrated)
//   - cursor:       the `x-next-cursor` for the next older page (undefined = no older page known)
//   - failedCursor: the last cursor whose backfill request failed, so we stop refetching it in a loop
//   - complete:     true once the server reported no further older page
//   - loading:      an in-flight backfill request for this key
//
// Split out of session-controller.ts so the pagination state and its derivations
// are independently testable without mounting the reactive controller.
export type HistoryMeta = {
  limit: Record<string, number | undefined>
  cursor: Record<string, string | undefined>
  failedCursor: Record<string, string | undefined>
  complete: Record<string, boolean | undefined>
  loading: Record<string, boolean | undefined>
}

export type HistoryMetaState = {
  meta: Accessor<HistoryMeta>
  setValue: <T extends keyof HistoryMeta>(field: T, key: string, value: HistoryMeta[T][string]) => void
}

function emptyHistoryMeta(): HistoryMeta {
  return {
    limit: {},
    cursor: {},
    failedCursor: {},
    complete: {},
    loading: {},
  }
}

export function createHistoryMetaState(): HistoryMetaState {
  const [meta, setMeta] = createSignal<HistoryMeta>(emptyHistoryMeta())
  const setValue = <T extends keyof HistoryMeta>(field: T, key: string, value: HistoryMeta[T][string]) =>
    setMeta((current) =>
      current[field][key] === value
        ? current
        : {
            ...current,
            [field]: {
              ...current[field],
              [key]: value,
            },
          },
    )
  return { meta, setValue }
}

// There is an older page to load when we have a cursor, that cursor is not the
// one whose backfill last failed (avoids a refetch loop), and the server has not
// declared the history complete.
export function historyHasMore(meta: HistoryMeta, key: string): boolean {
  return !!meta.cursor[key] && meta.cursor[key] !== meta.failedCursor[key] && meta.complete[key] !== true
}

export function historyIsLoading(meta: HistoryMeta, key: string): boolean {
  return meta.loading[key] === true
}

// Write-side of the older-history dampening: given a backfill request that
// rejected, decide which cursor (if any) to record as failed so that
// `historyHasMore()` stops offering it and the controller cannot refetch it in
// a loop. Only an older-page backfill (one that carried a `before` cursor)
// records a failure; a not-found error is a different concern (the session is
// being removed) and a foreground load with no `before` is a real error that
// must surface, so neither records a failedCursor.
export function backfillFailedCursor(input: {
  before: string | undefined
  sessionNotFound: boolean
}): string | undefined {
  if (input.sessionNotFound) return undefined
  return input.before
}
