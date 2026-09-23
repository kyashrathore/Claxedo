import { Show, createContext, createSignal, onCleanup, onMount, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"

/**
 * Most loads resolve within this window. Painting a loader and tearing it down
 * that quickly reads as flicker, so nothing is painted until a load outlasts it.
 */
export const LOADING_INDICATOR_DELAY_MS = 100

type Episode = { startedAt: number; holders: number }

const LoadingEpisodesContext = createContext<Map<string, Episode>>()

/**
 * Owns the loading episodes for everything below it. Without it, `episode` has
 * no effect and every indicator counts its delay from its own mount.
 */
export function LoadingEpisodesProvider(props: ParentProps) {
  return <LoadingEpisodesContext.Provider value={new Map()}>{props.children}</LoadingEpisodesContext.Provider>
}

const now = () => (typeof performance === "undefined" ? Date.now() : performance.now())

/**
 * Whether a loading indicator mounted now should be painted. It turns true once
 * the indicator has been mounted for `delayMs`.
 *
 * `episode` names one continuous wait that several successive indicators stand
 * in for (a session's transcript passes through three fallbacks on a cold
 * switch). The delay then counts from the first of them, so a wait that is
 * already showing a loader keeps showing one instead of going blank for another
 * `delayMs` each time the fallback element is swapped. The episode ends once no
 * indicator for it is mounted at the end of the current task.
 */
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
        // Fallback swaps dispose the old indicator before mounting the next one
        // in the same update; ending the episode synchronously would restart
        // the delay on every swap.
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

/**
 * Renders a loading indicator only once the load has outlasted
 * `LOADING_INDICATOR_DELAY_MS`. Readiness markers (`data-testid`, `aria-busy`,
 * `data-*-loading`) belong on the caller's element outside this component, so
 * the surface reports "not ready" from the first frame even while nothing is
 * painted.
 */
export function DelayedLoading(props: { children: JSX.Element; episode?: string; delayMs?: number }) {
  const visible = createLoadingIndicatorVisible({ episode: props.episode, delayMs: props.delayMs })
  return <Show when={visible()}>{props.children}</Show>
}
