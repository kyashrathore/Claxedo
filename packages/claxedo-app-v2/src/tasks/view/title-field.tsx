import { createEffect, onCleanup, onMount, type JSX } from "solid-js"
import { TASKS_BOUNDS } from "@claxedo/tasks"

export function TaskTitleField(props: {
  readonly value: string
  readonly placeholder: string
  readonly ariaLabel: string
  readonly testId: string
  readonly invalid?: boolean
  readonly onInput: (title: string) => void
}): JSX.Element {
  let field!: HTMLTextAreaElement
  const fit = () => {
    field.style.height = "0px"
    field.style.height = `${field.scrollHeight}px`
  }
  onMount(() => {
    const observer = new ResizeObserver(fit)
    observer.observe(field)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => {
    void props.value
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
