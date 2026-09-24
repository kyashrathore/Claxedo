import { type ComponentProps, splitProps } from "solid-js"
import "./textarea.css"

export interface TextareaProps extends ComponentProps<"textarea"> {

  invalid?: boolean
}

export function Textarea(props: TextareaProps) {
  const [local, textareaProps] = splitProps(props, ["class", "classList", "invalid", "disabled", "rows"])

  return (
    <div
      data-component="v2-textarea"
      data-disabled={local.disabled ? "" : undefined}
      data-invalid={local.invalid ? "" : undefined}
      classList={{
        "v2-textarea": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <textarea
        {...textareaProps}
        rows={local.rows ?? 3}
        disabled={local.disabled}
        aria-invalid={local.invalid ? true : undefined}
        data-slot="v2-textarea-textarea" classList={{ "v2-textarea-textarea": true }}
      />
    </div>
  )
}
