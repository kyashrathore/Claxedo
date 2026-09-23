import { createEffect, onCleanup, onMount } from "solid-js"
import { TASKS_BOUNDS } from "@claxedo/tasks"

/**
 * A task title is one line of text that may need several rows on screen: an
 * `<input>` clips a long title at the column's edge, so this is a textarea
 * that grows to its content and refuses line breaks. Enter submits the
 * enclosing form when there is one (the create dialog) and is otherwise inert;
 * newlines that arrive by paste collapse to spaces.
 */
export function TaskTitleField(props: {
  value: string
  placeholder: string
  ariaLabel: string
  testId: string
  invalid?: boolean
  onInput: (title: string) => void
}) {
  let field!: HTMLTextAreaElement
  const fit = () => {
    field.style.height = "0px"
    field.style.height = `${field.scrollHeight}px`
  }
  onMount(() => {
    // Width changes rewrap the text; jsdom has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(fit)
    observer.observe(field)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => {
    props.value
    fit()
  })
  return (
    <textarea
      ref={field}
      class="tsk-bare-title"
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      aria-invalid={props.invalid ? "true" : undefined}
      placeholder={props.placeholder}
      rows={1}
      maxLength={TASKS_BOUNDS.taskTitleMax}
      value={props.value}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return
        event.preventDefault()
        event.currentTarget.form?.requestSubmit()
      }}
      onInput={(event) => props.onInput(event.currentTarget.value.replace(/[\r\n]+/g, " "))}
    />
  )
}
