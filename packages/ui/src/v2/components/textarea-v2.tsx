import { omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import "./textarea-v2.css"

export interface TextareaV2Props extends ComponentProps<"textarea"> {
  /** Error styling for the field and value text. */
  invalid?: boolean
}

export function TextareaV2(props: TextareaV2Props) {
  const local = props,
    textareaProps = omit(props, "class", "invalid", "disabled", "rows")

  return (
    <div
      data-component="textarea-v2"
      data-disabled={local.disabled ? "" : undefined}
      data-invalid={local.invalid ? "" : undefined}
      class={["ui-textarea-v2", local.class]}
    >
      <textarea
        {...textareaProps}
        rows={local.rows ?? 3}
        disabled={local.disabled}
        aria-invalid={local.invalid ? "true" : undefined}
        data-slot="textarea-v2-textarea"
        class="ui-textarea-v2-textarea"
      />
    </div>
  )
}
