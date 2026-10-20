import type { JSX, ParentProps } from "solid-js"
import { ClaxedoIcon as Icon, type ClaxedoIconName } from "@/ui"

export function DetailsCard(props: ParentProps<{ readonly slot: DetailsCardSlot; readonly title: JSX.Element }>): JSX.Element {
  return (
    <section data-slot={props.slot} class="rounded-xl border border-border-weaker-base bg-surface-base px-3 py-2.5">
      <div class="flex h-6 items-center gap-2 text-12-medium text-text-weak">{props.title}</div>
      {props.children}
    </section>
  )
}

export type DetailsCardSlot = "details-environment" | "details-background"

export function DetailsRow(props: ParentProps<{ readonly icon: ClaxedoIconName; readonly title?: string }>): JSX.Element {
  return (
    <div class="flex h-7 min-w-0 items-center gap-2 text-compact text-text-base" title={props.title}>
      <Icon name={props.icon} size="small" class="shrink-0 text-icon-weak-base" />
      {props.children}
    </div>
  )
}
