import { Show } from "solid-js"
import { DiffChanges, Progress, Spinner } from "@/ui"
import type { SurfaceNodeProps } from "../model"
import { useSurfaceReader } from "./surface-runtime"

const PROGRESS_MAX = 100

export function ProgressView(props: SurfaceNodeProps<"Progress">) {
  const read = useSurfaceReader()
  const label = () => (props.def.label === undefined ? undefined : read.text(props.def.label, props.scope))
  return (
    <Progress data-slot="surface-progress" value={read.number(props.def.value, props.scope)} maxValue={props.def.max ?? PROGRESS_MAX} showValueLabel>
      {label()}
    </Progress>
  )
}

export function SpinnerView(props: SurfaceNodeProps<"Spinner">) {
  const read = useSurfaceReader()
  return (
    <span data-slot="surface-spinner" role="status">
      <Spinner />
      <Show when={props.def.label}>{(label) => <span class="text-13-regular text-text-weak">{read.text(label(), props.scope)}</span>}</Show>
    </span>
  )
}

export function DiffStatView(props: SurfaceNodeProps<"DiffStat">) {
  const read = useSurfaceReader()
  return <DiffChanges changes={{ additions: read.number(props.def.additions, props.scope), deletions: read.number(props.def.deletions, props.scope) }} />
}

export function EmptyStateView(props: SurfaceNodeProps<"EmptyState">) {
  const read = useSurfaceReader()
  return (
    <div data-slot="surface-empty">
      <p class="text-14-medium">{read.text(props.def.title, props.scope)}</p>
      <Show when={props.def.description}>
        {(description) => <p class="text-13-regular text-text-weak">{read.text(description(), props.scope)}</p>}
      </Show>
    </div>
  )
}
