import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"

const LOADING_INDICATOR_DELAY_MS = 100

export function DelayedLoading(props: { children: JSX.Element }) {
  const [visible, setVisible] = createSignal(false)
  onMount(() => {
    const timer = setTimeout(() => setVisible(true), LOADING_INDICATOR_DELAY_MS)
    onCleanup(() => clearTimeout(timer))
  })
  return <Show when={visible()}>{props.children}</Show>
}
