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
  refresh(): void
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

  const [outcome] = createSignal<AsyncOutcome<T>>(
    async (): Promise<AsyncOutcome<T>> => {
      const request = ++latestRequest
      try {
        const data = (await load()) as T | undefined
        if (request === latestRequest) authoritativeData = data
        return { request, status: "resolved", data }
      } catch (error) {
        return { request, status: "rejected", data: authoritativeData, error }
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
  })

  return {
    data: () => current().data,
    error: () => {
      const next = current()
      return next.status === "rejected" ? next.error : undefined
    },
    loading: () => !hasAuthoritativeOverride() && (current().status === "loading" || isPending(outcome)),
    refresh: () => refresh(outcome),
    mutate: (value) => {
      const request = ++latestRequest
      authoritativeData = value
      setOverride({ request, data: value })
    },
  }
}
