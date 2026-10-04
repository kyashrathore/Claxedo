import { Show, type JSX } from "solid-js"
import { useElapsed } from "@/lib/delay"

export function DelayedLoading(props: { children: JSX.Element }) {
  const visible = useElapsed()
  return <Show when={visible()}>{props.children}</Show>
}
