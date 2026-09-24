import { For, onMount, Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import { Button } from "./button"
import { FileIcon } from "./file-icon"
import { createMentionSuggestions, type LineCommentEditorMention, type MentionItem, type MentionSuggestions } from "./line-comment-mentions"
import "./line-comment.css"

export interface LineCommentEditorProps extends Omit<ComponentProps<"div">, "children" | "onInput" | "onSubmit"> {
  heading?: JSX.Element | string
  value: string
  onInput: (value: string) => void
  onCancel: () => void
  onSubmit: (value: string) => void
  selection: JSX.Element
  placeholder?: string
  rows?: number
  cancelLabel?: string
  submitLabel?: string
  autofocus?: boolean
  mention?: LineCommentEditorMention
}

const separator = (path: string) => Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
const directoryOf = (path: string) => (path.endsWith("/") ? path : path.slice(0, separator(path) + 1))
const fileOf = (path: string) => (path.endsWith("/") ? "" : path.slice(separator(path) + 1))

function MentionRow(props: { item: MentionItem; mentions: MentionSuggestions }) {
  return (
    <button
      type="button"
      data-slot="v2-line-comment-mention-item"
      class="v2-line-comment-mention-item"
      data-active={props.mentions.list.active() === props.item.path ? "" : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => props.mentions.list.setActive(props.item.path)}
      onClick={() => props.mentions.select(props.item)}
    >
      <FileIcon node={{ path: props.item.path, type: "file" }} class="shrink-0 size-4" />
      <div data-slot="v2-line-comment-mention-path">
        <span data-slot="v2-line-comment-mention-dir">{directoryOf(props.item.path)}</span>
        <Show when={fileOf(props.item.path)}>
          <span data-slot="v2-line-comment-mention-file">{fileOf(props.item.path)}</span>
        </Show>
      </div>
    </button>
  )
}

function MentionList(props: { mentions: MentionSuggestions }) {
  return (
    <Show when={props.mentions.open() && props.mentions.list.flat().length > 0}>
      <div data-slot="v2-line-comment-mention-list">
        <For each={props.mentions.list.flat().slice(0, 10)}>{(item) => <MentionRow item={item} mentions={props.mentions} />}</For>
      </div>
    </Show>
  )
}

export function LineCommentEditor(props: LineCommentEditorProps) {
  let textarea: HTMLTextAreaElement | undefined
  const [local, rest] = splitProps(props, [
    "heading",
    "value",
    "onInput",
    "onCancel",
    "onSubmit",
    "selection",
    "placeholder",
    "rows",
    "cancelLabel",
    "submitLabel",
    "autofocus",
    "mention",
    "class",
    "classList",
  ])
  const mentions = createMentionSuggestions({
    textarea: () => textarea,
    mention: () => local.mention,
    onInput: (value) => local.onInput(value),
  })
  const canSubmit = () => local.value.trim().length > 0
  const submit = () => {
    const value = local.value.trim()
    if (value) local.onSubmit(value)
  }
  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    event.stopPropagation()
    if (event.isComposing || event.keyCode === 229) return
    if (mentions.onKeyDown(event)) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.currentTarget.blur()
      local.onCancel()
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }
  onMount(() => {
    if (local.autofocus !== false) requestAnimationFrame(() => textarea?.focus())
  })

  return (
    <div
      {...rest}
      data-component="v2-line-comment"
      data-variant="editor"
      classList={{ ...local.classList, [local.class ?? ""]: !!local.class }}
    >
      <div data-slot="v2-line-comment-shell">
        <div data-slot="v2-line-comment-field">
          <div data-slot="v2-line-comment-label">{local.heading ?? "Comment"}</div>
          <textarea
            ref={(element) => (textarea = element)}
            data-slot="v2-line-comment-textarea"
            class="v2-line-comment-textarea"
            rows={local.rows ?? 3}
            placeholder={local.placeholder ?? "Add context for this change"}
            value={local.value}
            onInput={(event) => {
              local.onInput(event.currentTarget.value)
              mentions.sync()
            }}
            onClick={() => mentions.sync()}
            onSelect={() => mentions.sync()}
            onKeyDown={onKeyDown}
          />
          <MentionList mentions={mentions} />
        </div>
        <div data-slot="v2-line-comment-footer">
          <div data-slot="v2-line-comment-footer-meta">{local.selection}</div>
          <div data-slot="v2-line-comment-footer-actions">
            <Button type="button" size="normal" variant="neutral" onClick={() => local.onCancel()}>
              {local.cancelLabel ?? "Cancel"}
            </Button>
            <Button type="button" size="normal" variant="contrast" disabled={!canSubmit()} onClick={submit}>
              {local.submitLabel ?? "Comment"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
