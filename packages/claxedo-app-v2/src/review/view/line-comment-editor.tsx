import { createSignal, onMount, type JSX } from "solid-js"
import { t } from "../i18n"

export function LineCommentEditor(props: {
  readonly label: string
  readonly onSubmit: (text: string) => void
  readonly onCancel: () => void
}): JSX.Element {
  const [text, setText] = createSignal("")
  let field: HTMLTextAreaElement | undefined
  onMount(() => field?.focus())
  const submit = () => {
    const value = text().trim()
    if (!value) return
    props.onSubmit(value)
    setText("")
  }
  return (
    <form
      data-component="line-comment-editor"
      class="flex flex-col gap-2 border-y border-border-weak-base bg-background-base px-2 py-2 font-sans"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <label class="text-11-regular text-text-weak">
        {props.label}
        <textarea
          ref={field}
          rows={2}
          value={text()}
          placeholder={t("review.comment.placeholder")}
          class="mt-1 w-full resize-y rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-12-regular text-text-base outline-none placeholder:text-text-weak focus:border-border-strong-base"
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onCancel()
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit()
          }}
        />
      </label>
      <div class="flex gap-2">
        <button
          type="submit"
          disabled={!text().trim()}
          class="min-h-8 rounded-md bg-surface-base-active px-3 text-12-medium text-text-base disabled:opacity-50 pointer-coarse:min-h-11"
        >
          {t("review.comment.add")}
        </button>
        <button
          type="button"
          class="min-h-8 rounded-md px-3 text-12-medium text-text-weak hover:bg-surface-base-hover pointer-coarse:min-h-11"
          onClick={() => props.onCancel()}
        >
          {t("review.comment.cancel")}
        </button>
      </div>
    </form>
  )
}
