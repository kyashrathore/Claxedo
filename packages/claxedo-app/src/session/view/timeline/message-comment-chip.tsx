import { Match, Show, Switch, type JSX } from "solid-js"
import { FileIcon, Icon } from "@/ui"
import { getFilename } from "@/ui/utils"
import { ImageMarkBadge } from "@/lib/image-mark-badge"
import { MessageComment } from "./message-timeline.data"
import type { TimelineTranslate } from "./model"

function QuoteCommentContent(props: { readonly quote: MessageComment.QuoteComment; readonly t: TimelineTranslate }): JSX.Element {
  const path = () => (props.quote.source.kind === "file" ? props.quote.source.path : undefined)
  const label = () => {
    const file = path()
    if (file) return getFilename(file)
    return props.t(props.quote.source.kind === "plan" ? "session.timeline.quote.plan" : "session.timeline.quote.conversation")
  }
  return (
    <>
      <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
        <Show when={path()} fallback={<Icon name="comment" size="small" class="size-3.5 shrink-0 text-icon-weak" />}>
          {(file) => <FileIcon node={{ path: file(), type: "file" }} class="size-3.5 shrink-0" />}
        </Show>
        <span class="truncate">{label()}</span>
      </div>
      <blockquote class="mt-1 border-l-2 border-border-weak-base pl-1.5 text-12-regular text-text-weak line-clamp-2 break-words">
        {props.quote.quote}
      </blockquote>
      <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">{props.quote.comment}</div>
    </>
  )
}

function FileCommentContent(props: { readonly file: MessageComment.FileComment }): JSX.Element {
  return (
    <>
      <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
        <FileIcon node={{ path: props.file.path, type: "file" }} class="size-3.5 shrink-0" />
        <span class="truncate">{getFilename(props.file.path)}</span>
        <Show when={props.file.selection}>
          {(selection) => (
            <span class="shrink-0 text-text-weak">
              {selection().startLine === selection().endLine
                ? `:${selection().startLine}`
                : `:${selection().startLine}-${selection().endLine}`}
            </span>
          )}
        </Show>
      </div>
      <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">{props.file.comment}</div>
    </>
  )
}

export function MessageCommentChip(props: { readonly comment: MessageComment.MessageComment; readonly t: TimelineTranslate }): JSX.Element {
  return (
    <div class="shrink-0 max-w-[260px] rounded-md border border-border-weak-base bg-background-stronger px-2.5 py-2">
      <Switch>
        <Match when={MessageComment.asImageMark(props.comment)}>
          {(mark) => (
            <div class="flex items-start gap-1.5 min-w-0">
              <ImageMarkBadge number={mark().number} />
              <span class="text-12-regular text-text-strong whitespace-pre-wrap break-words">{mark().comment}</span>
            </div>
          )}
        </Match>
        <Match when={MessageComment.asQuote(props.comment)}>
          {(quote) => <QuoteCommentContent quote={quote()} t={props.t} />}
        </Match>
        <Match when={MessageComment.asFile(props.comment)}>
          {(file) => <FileCommentContent file={file()} />}
        </Match>
      </Switch>
    </div>
  )
}
