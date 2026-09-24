import { Show } from "solid-js"
import { Icon } from "@/ui"

export function QuestionMark(props: { multi: boolean; picked: boolean; onClick?: (event: MouseEvent) => void }) {
  return (
    <span data-slot="question-option-check" aria-hidden="true" onClick={props.onClick}>
      <span
        data-slot="question-option-box"
        class="ui-question-option-box"
        data-type={props.multi ? "checkbox" : "radio"}
        data-picked={props.picked}
      >
        <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" class="ui-question-option-radio-dot" />}>
          <Icon name="check-small" size="small" />
        </Show>
      </span>
    </span>
  )
}

export function QuestionOption(props: {
  multi: boolean
  picked: boolean
  label: string
  description?: string
  disabled: boolean
  focused: boolean
  ref?: (el: HTMLButtonElement) => void
  onFocus?: VoidFunction
  onClick: VoidFunction
}) {
  return (
    <button
      type="button"
      ref={props.ref}
      data-slot="question-option"
      data-picked={props.picked}
      role={props.multi ? "checkbox" : "radio"}
      aria-checked={props.picked}
      tabindex={props.focused ? 0 : -1}
      disabled={props.disabled}
      onFocus={props.onFocus}
      onClick={props.onClick}
    >
      <QuestionMark multi={props.multi} picked={props.picked} />
      <span data-slot="question-option-main">
        <span data-slot="option-label">{props.label}</span>
        <Show when={props.description}>
          <span data-slot="option-description">{props.description}</span>
        </Show>
      </span>
    </button>
  )
}

function resizeInput(el: HTMLTextAreaElement) {
  el.style.height = "0px"
  el.style.height = `${el.scrollHeight}px`
}

function focusInput(el: HTMLTextAreaElement) {
  requestAnimationFrame(() => {
    el.focus()
    resizeInput(el)
  })
}

type CustomProps = {
  multi: boolean
  picked: boolean
  editing: boolean
  focused: boolean
  disabled: boolean
  label: string
  placeholder: string
  value: string
  ref?: (el: HTMLButtonElement) => void
  onFocus: VoidFunction
  onOpen: VoidFunction
  onToggleMark: VoidFunction
  onInput: (value: string) => void
  onCommit: VoidFunction
  onCancel: VoidFunction
}

function customKeyDown(event: KeyboardEvent, props: CustomProps) {
  if (event.key === "Escape") {
    event.preventDefault()
    return props.onCancel()
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey) return
  if (event.key !== "Enter" || event.shiftKey) return
  event.preventDefault()
  props.onCommit()
}

function focusFormInput(event: MouseEvent & { currentTarget: HTMLFormElement }, disabled: boolean) {
  if (disabled) return event.preventDefault()
  if (event.target instanceof HTMLTextAreaElement) return
  event.currentTarget.querySelector<HTMLTextAreaElement>('[data-slot="question-custom-input"]')?.focus()
}

export function QuestionCustomOption(props: CustomProps) {
  const mark = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onToggleMark()
  }
  return (
    <Show
      when={props.editing}
      fallback={
        <button
          type="button"
          ref={props.ref}
          data-slot="question-option"
          data-custom="true"
          data-picked={props.picked}
          role={props.multi ? "checkbox" : "radio"}
          aria-checked={props.picked}
          tabindex={props.focused ? 0 : -1}
          disabled={props.disabled}
          onFocus={props.onFocus}
          onClick={props.onOpen}
        >
          <QuestionMark multi={props.multi} picked={props.picked} onClick={mark} />
          <span data-slot="question-option-main">
            <span data-slot="option-label">{props.label}</span>
            <span data-slot="option-description">{props.value || props.placeholder}</span>
          </span>
        </button>
      }
    >
      <form
        data-slot="question-option"
        data-custom="true"
        data-picked={props.picked}
        role={props.multi ? "checkbox" : "radio"}
        aria-checked={props.picked}
        onMouseDown={(event) => focusFormInput(event, props.disabled)}
        onSubmit={(event) => {
          event.preventDefault()
          props.onCommit()
        }}
      >
        <QuestionMark multi={props.multi} picked={props.picked} onClick={mark} />
        <span data-slot="question-option-main">
          <span data-slot="option-label">{props.label}</span>
          <textarea
            ref={focusInput}
            data-slot="question-custom-input"
            class="ui-question-custom-input"
            placeholder={props.placeholder}
            value={props.value}
            rows={1}
            disabled={props.disabled}
            onKeyDown={(event) => customKeyDown(event, props)}
            onInput={(event) => {
              props.onInput(event.currentTarget.value)
              resizeInput(event.currentTarget)
            }}
          />
        </span>
      </form>
    </Show>
  )
}
