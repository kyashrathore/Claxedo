import { For, Show, type JSX } from "solid-js"
import { useElapsed } from "@/lib/delay"

const WIDTHS = ["82%", "69%", "54%", "61%", "46%"]

export function PlaceholderRows(props: { readonly label: string; readonly rows?: number }): JSX.Element {
  const elapsed = useElapsed()
  return (
    <Show when={elapsed()}>
      <div role="status" aria-label={props.label} class="flex flex-col gap-1 p-2">
        <For each={WIDTHS.slice(0, props.rows ?? 3)}>
          {(width) => <div class="h-6 rounded-md bg-background-layer-01" style={{ width }} />}
        </For>
      </div>
    </Show>
  )
}
