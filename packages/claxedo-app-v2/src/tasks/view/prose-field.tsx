import type { JSX } from "solid-js"

export function ProseField(props: {
  readonly value: string
  readonly placeholder: string
  readonly ariaLabel: string
  readonly testId: string
  readonly onChange: (markdown: string) => void
}): JSX.Element {
  return (
    <textarea
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      placeholder={props.placeholder}
      value={props.value}
      onInput={(event) => props.onChange(event.currentTarget.value)}
    />
  )
}
