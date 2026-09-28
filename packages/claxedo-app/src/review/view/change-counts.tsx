import { Show, type JSX } from "solid-js"

export function ChangeCounts(props: {
  readonly additions: number
  readonly deletions: number
  readonly class?: string
}): JSX.Element {
  return (
    <span class={`flex shrink-0 items-center gap-1.5 font-normal tabular-nums ${props.class ?? ""}`}>
      <Show when={props.additions > 0}>
        <span class="text-[color-mix(in_srgb,var(--text-diff-add-base)_82%,var(--text-weaker))]">{`+${props.additions}`}</span>
      </Show>
      <Show when={props.deletions > 0}>
        <span class="text-[color-mix(in_srgb,var(--text-diff-delete-base)_76%,var(--text-weaker))]">{`-${props.deletions}`}</span>
      </Show>
    </span>
  )
}
