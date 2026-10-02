import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { HoverCard } from "@kobalte/core/hover-card"
import { Icon } from "@/ui"
import type { ComposerTextKey } from "../i18n"
import type { QuoteContextItem } from "../model"
import { AnnotationEditor } from "../quote/annotation-editor"
import type { ComposerKey } from "../store"
import { AnnotationList } from "./annotation-card"
import { ChipRemoveButton } from "./context-chip"

export type AnnotationsChipProps = {
  readonly items: readonly QuoteContextItem[]
  readonly composerKey: ComposerKey
  readonly reveal: (item: QuoteContextItem) => void
  readonly remove: (item: QuoteContextItem) => void
  readonly removeAll: () => void
  readonly t: (key: ComposerTextKey, params?: Record<string, string>) => string
}

export function AnnotationsChip(props: AnnotationsChipProps): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [editing, setEditing] = createSignal<string>()
  const [chip, setChip] = createSignal<HTMLElement>()
  const edited = createMemo(() => {
    const index = props.items.findIndex((item) => item.key === editing())
    return index < 0 ? undefined : { item: props.items[index]!, number: index + 1 }
  })
  const label = () => {
    const count = String(props.items.length)
    return props.t(props.items.length === 1 ? "prompt.annotations.one" : "prompt.annotations.other", { count })
  }
  const edit = (item: QuoteContextItem) => {
    setOpen(false)
    props.reveal(item)
    setEditing(item.key)
  }
  return (
    <div ref={setChip} class="group shrink-0 flex h-8 items-center gap-1 rounded-md pl-2.5 pr-1 shadow-xs-border bg-background-stronger hover:bg-surface-interactive-weak [@media(pointer:coarse)]:h-11">
      <HoverCard open={open()} onOpenChange={setOpen} placement="top-start" gutter={8} openDelay={100} closeDelay={200}>
        <HoverCard.Trigger as="button" role="button" type="button" aria-expanded={open()} class="flex h-8 items-center gap-1.5 text-12-medium text-text-strong [@media(pointer:coarse)]:min-h-11" onClick={() => setOpen(!open())}>
          <Icon name="comment" size="small" class="text-icon-weak" />
          <span>{label()}</span>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content role="dialog" aria-label={props.t("prompt.annotations.open")} class="z-50 max-h-[360px] w-[360px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl bg-v2-background-bg-base p-1.5 shadow-[var(--v2-elevation-raised)]">
            <AnnotationList items={props.items} edit={edit} remove={props.remove} t={props.t} />
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard>
      <span class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <ChipRemoveButton label={props.t("prompt.annotations.removeAll")} onRemove={props.removeAll} />
      </span>
      <Show when={edited()}>
        {(current) => (
          <AnnotationEditor
            composerKey={props.composerKey}
            item={current().item}
            number={current().number}
            chip={chip}
            onClose={() => setEditing(undefined)}
          />
        )}
      </Show>
    </div>
  )
}
