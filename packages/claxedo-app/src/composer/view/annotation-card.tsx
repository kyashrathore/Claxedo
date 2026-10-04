import { For, type JSX } from "solid-js"
import { ClaxedoIconButton as IconButton } from "@/ui"
import { getFilename } from "@/ui/utils"
import type { ComposerTextKey } from "../i18n"
import type { QuoteContextItem } from "../model"

type Text = (key: ComposerTextKey, params?: Record<string, string>) => string

function annotationSourceLabel(item: QuoteContextItem, t: Text): string {
  const source = item.source
  if (source.kind === "file") return t("prompt.annotations.source.file", { file: getFilename(source.path) })
  return t(source.kind === "plan" ? "prompt.annotations.source.plan" : "prompt.annotations.source.conversation")
}

function AnnotationRow(props: {
  readonly item: QuoteContextItem
  readonly number: number
  readonly edit: (item: QuoteContextItem) => void
  readonly remove: (item: QuoteContextItem) => void
  readonly t: Text
}): JSX.Element {
  return (
    <li class="flex gap-2 rounded-lg px-2 py-2 hover:bg-surface-raised-base-hover">
      <span class="w-4 shrink-0 text-13-regular text-text-weak tabular-nums">{props.number}.</span>
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="text-12-regular text-text-weak">
          {props.t("prompt.annotations.selectedText")} {annotationSourceLabel(props.item, props.t)}
        </span>
        <p class="text-13-regular text-text-strong whitespace-pre-wrap break-words line-clamp-6">{props.item.quote}</p>
        <p class="border-l-2 border-border-weak-base pl-2 text-13-regular text-text-base whitespace-pre-wrap break-words">
          {props.item.comment}
        </p>
      </div>
      <div class="flex shrink-0 items-start gap-0.5">
        <IconButton icon="edit" variant="ghost" size="small" class="[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11" aria-label={props.t("prompt.annotations.edit")} onClick={() => props.edit(props.item)} />
        <IconButton icon="trash" variant="ghost" size="small" class="[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11" aria-label={props.t("prompt.annotations.remove")} onClick={() => props.remove(props.item)} />
      </div>
    </li>
  )
}

export function AnnotationList(props: {
  readonly items: readonly QuoteContextItem[]
  readonly edit: (item: QuoteContextItem) => void
  readonly remove: (item: QuoteContextItem) => void
  readonly t: Text
}): JSX.Element {
  return (
    <ul class="flex flex-col gap-0.5">
      <For each={props.items}>
        {(item, index) => <AnnotationRow item={item} number={index() + 1} edit={props.edit} remove={props.remove} t={props.t} />}
      </For>
    </ul>
  )
}
