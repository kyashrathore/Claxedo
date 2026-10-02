import { createEffect, createSignal, For, onMount, Show, splitProps } from "solid-js"
import { FileIcon, Icon, useFilteredList } from "@/ui"
import { getDirectory, getFilename } from "@/ui/utils"
import { useTranscriptI18n } from "./i18n"
import { LineCommentAnchor, type LineCommentAnchorProps } from "./line-comment"

export type LineCommentEditorProps = Omit<LineCommentAnchorProps, "children" | "open" | "variant" | "onClick"> & {
  value: string
  onInput: (value: string) => void
  onCancel: VoidFunction
  onSubmit: (value: string) => void
  placeholder?: string
  autofocus?: boolean
  submitLabel?: string
  mention?: {
    items: (query: string) => string[] | Promise<string[]>
  }
}

const EDITOR_MAX_HEIGHT_PX = 200

function fitHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto"
  textarea.style.height = `${Math.min(textarea.scrollHeight, EDITOR_MAX_HEIGHT_PX)}px`
}

function mentionAtCaret(element: HTMLTextAreaElement | undefined) {
  if (!element || element.selectionStart !== element.selectionEnd) return undefined
  const end = element.selectionStart
  const match = element.value.slice(0, end).match(/@(\S*)$/)
  return match ? { query: match[1] ?? "", start: end - match[0].length, end } : undefined
}

function createMentions(props: Pick<LineCommentEditorProps, "mention" | "onInput">, textarea: () => HTMLTextAreaElement | undefined) {
  const [open, setOpen] = createSignal(false)
  const current = () => (props.mention ? mentionAtCaret(textarea()) : undefined)
  const close = () => {
    setOpen(false)
    list.clear()
  }
  const select = (item: { path: string } | undefined) => {
    const element = textarea()
    const query = current()
    if (!item || !element || !query) return
    props.onInput(`${element.value.slice(0, query.start)}@${item.path} ${element.value.slice(query.end)}`)
    close()
    const cursor = query.start + item.path.length + 2
    requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(cursor, cursor)
    })
  }
  const list = useFilteredList<{ path: string }>({
    items: async (query) => {
      if (!props.mention || !query.trim()) return []
      return (await props.mention.items(query)).map((path) => ({ path }))
    },
    key: (item) => item.path,
    filterKeys: ["path"],
    skipFilter: () => true,
    onSelect: select,
  })
  const sync = () => {
    const item = current()
    if (!item) return close()
    setOpen(true)
    list.onInput(item.query)
  }
  const shown = () => (open() ? list.flat() : [])
  return { list, shown, sync, close, select }
}

type Mentions = ReturnType<typeof createMentions>

function mentionKey(event: KeyboardEvent, mentions: Mentions): boolean {
  if (mentions.shown().length === 0) return false
  if (event.key === "Escape") {
    mentions.close()
    return true
  }
  if (event.key === "Tab") {
    const items = mentions.shown()
    mentions.select(items.find((item) => item.path === mentions.list.active()) ?? items[0])
    return true
  }
  const ctrlNav = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "n" || event.key === "p")
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter" && !ctrlNav) return false
  mentions.list.onKeyDown(event)
  return true
}

function MentionList(props: { mentions: Mentions }) {
  return (
    <Show when={props.mentions.shown().length > 0}>
      <div data-slot="line-comment-mention-list">
        <For each={props.mentions.shown().slice(0, 10)}>
          {(item) => (
            <button
              type="button"
              data-slot="line-comment-mention-item"
              data-active={props.mentions.list.active() === item.path ? "" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => props.mentions.list.setActive(item.path)}
              onClick={() => props.mentions.select(item)}
            >
              <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
              <div data-slot="line-comment-mention-path">
                <span data-slot="line-comment-mention-dir">{item.path.endsWith("/") ? item.path : getDirectory(item.path)}</span>
                <Show when={!item.path.endsWith("/")}>
                  <span data-slot="line-comment-mention-file">{getFilename(item.path)}</span>
                </Show>
              </div>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

export const LineCommentEditor = (props: LineCommentEditorProps) => {
  const i18n = useTranscriptI18n()
  const [split, rest] = splitProps(props, ["value", "onInput", "onCancel", "onSubmit", "placeholder", "autofocus", "submitLabel", "mention"])
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>()
  const mentions = createMentions(split, textarea)
  const submit = () => {
    const value = split.value.trim()
    if (value) split.onSubmit(value)
  }
  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    if (event.isComposing || event.keyCode === 229) return
    event.stopPropagation()
    if (mentionKey(event, mentions)) return event.preventDefault()
    if (event.key === "Escape") {
      event.preventDefault()
      event.currentTarget.blur()
      return split.onCancel()
    }
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    submit()
  }
  createEffect(() => {
    split.value
    const element = textarea()
    if (element) fitHeight(element)
  })
  onMount(() => {
    if (split.autofocus !== false) requestAnimationFrame(() => textarea()?.focus())
  })
  return (
    <LineCommentAnchor {...rest} open={true} variant="editor" hideButton={props.inline} onClick={() => textarea()?.focus()}>
      <div data-slot="line-comment-editor">
        <div data-slot="line-comment-field">
          <textarea
            ref={setTextarea}
            data-slot="line-comment-textarea"
            autofocus={split.autofocus !== false}
            rows={1}
            placeholder={split.placeholder ?? i18n.t("transcript.lineComment.placeholder")}
            value={split.value}
            on:input={(event) => {
              split.onInput((event.currentTarget as HTMLTextAreaElement).value)
              mentions.sync()
            }}
            on:click={() => mentions.sync()}
            on:select={() => mentions.sync()}
            on:keydown={(event) => onKeyDown(event as KeyboardEvent & { currentTarget: HTMLTextAreaElement })}
          />
          <button
            type="button"
            data-slot="line-comment-submit"
            aria-label={split.submitLabel ?? i18n.t("transcript.lineComment.submit")}
            disabled={split.value.trim().length === 0}
            on:mousedown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            on:click={(event) => {
              event.stopPropagation()
              submit()
            }}
          >
            <Icon name="check" size="small" />
          </button>
        </div>
        <MentionList mentions={mentions} />
      </div>
    </LineCommentAnchor>
  )
}
