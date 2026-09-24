import { Show, createContext, createSignal, onCleanup, onMount, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"

export const LOADING_INDICATOR_DELAY_MS = 100

type Episode = { startedAt: number; holders: number }

const LoadingEpisodesContext = createContext<Map<string, Episode>>()

export function LoadingEpisodesProvider(props: ParentProps) {
  return <LoadingEpisodesContext.Provider value={new Map()}>{props.children}</LoadingEpisodesContext.Provider>
}

const now = () => (typeof performance === "undefined" ? Date.now() : performance.now())

export function createLoadingIndicatorVisible(input?: { episode?: string; delayMs?: number }): Accessor<boolean> {
  const episodes = useContext(LoadingEpisodesContext)
  const delayMs = input?.delayMs ?? LOADING_INDICATOR_DELAY_MS
  const [visible, setVisible] = createSignal(false)
  onMount(() => {
    const key = input?.episode
    let startedAt = now()
    if (key && episodes) {
      const episode = episodes.get(key) ?? { startedAt, holders: 0 }
      episode.holders += 1
      episodes.set(key, episode)
      startedAt = episode.startedAt
      onCleanup(() => {
        episode.holders -= 1
        queueMicrotask(() => {
          if (episode.holders === 0 && episodes.get(key) === episode) episodes.delete(key)
        })
      })
    }
    const remaining = delayMs - (now() - startedAt)
    if (remaining <= 0) {
      setVisible(true)
      return
    }
    const timer = setTimeout(() => setVisible(true), remaining)
    onCleanup(() => clearTimeout(timer))
  })
  return visible
}

export function DelayedLoading(props: { children: JSX.Element; episode?: string; delayMs?: number }) {
  const visible = createLoadingIndicatorVisible({ episode: props.episode, delayMs: props.delayMs })
  return <Show when={visible()}>{props.children}</Show>
}
