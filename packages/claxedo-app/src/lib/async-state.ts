import { createSignal, isPending, onCleanup, refresh } from "solid-js"

type AsyncOutcome<T> =
  | { request: number; status: "loading"; data: T | undefined }
  | { request: number; status: "resolved"; data: T | undefined }
  | { request: number; status: "rejected"; data: T | undefined; error: unknown }

type AsyncOverride<T> = { request: number; data: T | undefined }

export type AsyncState<T> = {
  data(): T | undefined
  error(): unknown
  loading(): boolean
  /**
   * Re-run the loader. The promise settles when the run does, whether it
   * resolved or failed — it never rejects, so the many callers that fire and
   * forget (`void refresh()`) cannot mint an unhandled rejection. A caller that
   * needs to know the outcome reads `error()` afterwards; that is the only way
   * to observe a failed revalidation, since the failure lives on the state.
   */
  refresh(): Promise<void>
  mutate(value: T | undefined): void
}

type AsyncValue<Load extends () => unknown> = Exclude<Awaited<ReturnType<Load>>, undefined>

export function createAsyncState<Load extends () => unknown>(
  load: Load,
  options: { initialValue?: AsyncValue<Load> } = {},
): AsyncState<AsyncValue<Load>> {
  type T = AsyncValue<Load>
  let authoritativeData = options.initialValue as T | undefined
  let latestRequest = 0
  const [override, setOverride] = createSignal<AsyncOverride<T>>()

  // Everyone waiting on the run in flight. `refresh()` has to return a promise
  // that settles with the loader, and the loader is the only place that knows
  // when it did — `refresh(outcome)` itself returns nothing.
  let waiting: Array<() => void> = []
  const settleWaiters = () => {
    const pending = waiting
    waiting = []
    for (const resolve of pending) resolve()
  }

  const [outcome] = createSignal<AsyncOutcome<T>>(
    async (): Promise<AsyncOutcome<T>> => {
      const request = ++latestRequest
      try {
        const data = (await load()) as T | undefined
        if (request === latestRequest) authoritativeData = data
        return { request, status: "resolved", data }
      } catch (error) {
        return { request, status: "rejected", data: authoritativeData, error }
      } finally {
        settleWaiters()
      }
    },
    { loadingValue: { request: 0, status: "loading", data: options.initialValue } },
  )

  const current = () => {
    const next = outcome()
    const local = override()
    return local && local.request > next.request
      ? ({ request: local.request, status: "resolved", data: local.data } as const)
      : next
  }

  const hasAuthoritativeOverride = () => {
    const next = outcome()
    const local = override()
    return !!local && local.request === latestRequest && local.request > next.request
  }

  onCleanup(() => {
    latestRequest++
    // A disposed state will never run its loader again, so anything still
    // waiting has to be released here or its caller waits forever.
    settleWaiters()
  })

  return {
    // Stale-while-revalidate, matching Solid 1's createResource: while a
    // refresh is in flight the accessor keeps the last resolved value instead
    // of flickering to the loading placeholder. ConnectionGate gates the
    // ENTIRE app shell on this accessor - the flicker unmounted and remounted
    // the whole workbench (panes, rail, retained sessions) on the first
    // background health recovery, ~10s into every session.
    data: () => {
      const next = current()
      return next.status === "loading" && next.data === undefined ? authoritativeData : next.data
    },
    error: () => {
      const next = current()
      return next.status === "rejected" ? next.error : undefined
    },
    loading: () => !hasAuthoritativeOverride() && (current().status === "loading" || isPending(outcome)),
    refresh: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve)
        refresh(outcome)
      }),
    mutate: (value) => {
      const request = ++latestRequest
      authoritativeData = value
      setOverride({ request, data: value })
    },
  }
}
