import type { Accessor } from "solid-js"
import type { TextFieldEvents } from "./text-field-events"

export type BorderlessFieldProps = {
  readonly label: Accessor<string>
  readonly placeholder: Accessor<string | undefined>
  readonly value: Accessor<string>
  readonly events: TextFieldEvents
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ")
}

export function TitleFieldView(props: BorderlessFieldProps) {
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) event.preventDefault()
    props.events.keyDown(event)
  }
  return (
    <textarea
      data-slot="surface-title-input"
      rows={1}
      aria-label={props.label()}
      placeholder={props.placeholder()}
      value={props.value()}
      onInput={(event) => {
        const text = oneLine(event.currentTarget.value)
        if (text !== event.currentTarget.value) event.currentTarget.value = text
        props.events.input(text)
      }}
      onKeyDown={keyDown}
      onBlur={() => props.events.blur()}
    />
  )
}

export function InlineFieldView(props: BorderlessFieldProps) {
  return (
    <input
      data-slot="surface-inline-input"
      type="text"
      aria-label={props.label()}
      placeholder={props.placeholder()}
      value={props.value()}
      onInput={(event) => props.events.input(event.currentTarget.value)}
      onKeyDown={(event) => props.events.keyDown(event)}
      onBlur={() => props.events.blur()}
    />
  )
}
