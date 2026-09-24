import { type ComponentProps, splitProps } from "solid-js"
import "./textarea.css"

export interface TextareaProps extends ComponentProps<"textarea"> {

  invalid?: boolean
}

export function Textarea(props: TextareaProps) {
  const [local, textareaProps] = splitProps(props, ["class", "classList", "invalid", "disabled", "rows"])

  return (
    <div
      data-component="textarea"
      data-disabled={local.disabled ? "" : undefined}
      data-invalid={local.invalid ? "" : undefined}
      classList={{
        "ui-textarea": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <textarea
        {...textareaProps}
        rows={local.rows ?? 3}
        disabled={local.disabled}
        aria-invalid={local.invalid ? true : undefined}
        data-slot="textarea-textarea" classList={{ "ui-textarea-textarea": true }}
      />
    </div>
  )
}
