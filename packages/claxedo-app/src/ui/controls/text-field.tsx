import { Show, splitProps } from "solid-js"
import { FieldV2 } from "@opencode-ai/ui/v2/field-v2"
import { TextInputV2, type TextInputV2Props } from "@opencode-ai/ui/v2/text-input-v2"

export interface TextFieldProps
  extends Omit<TextInputV2Props, "value" | "onChange" | "onInput" | "invalid" | "showCopyButton" | "onCopyClick" | "class" | "classList"> {
  label?: string
  hideLabel?: boolean
  description?: string
  error?: string
  invalid?: boolean
  value?: string
  onChange?: (value: string) => void
  copyable?: boolean
  class?: string
}

export function TextField(props: TextFieldProps) {
  const [local, input] = splitProps(props, ["label", "hideLabel", "description", "error", "invalid", "value", "onChange", "copyable", "class"])
  return (
    <FieldV2 invalid={local.invalid} class={local.class}>
      <Show when={local.label}>{(label) => <FieldV2.Label classList={{ "sr-only": local.hideLabel }}>{label()}</FieldV2.Label>}</Show>
      <TextInputV2
        {...input}
        class="text-input-v2--full-width"
        value={local.value ?? ""}
        onInput={(event) => local.onChange?.(event.currentTarget.value)}
        showCopyButton={local.copyable}
        onCopyClick={() => void navigator.clipboard.writeText(local.value ?? "")}
      />
      <Show when={local.description}>{(description) => <FieldV2.Suffix>{description()}</FieldV2.Suffix>}</Show>
      <Show when={local.error}>
        {(error) => (
          <FieldV2.Suffix>
            <span class="text-icon-critical-base">{error()}</span>
          </FieldV2.Suffix>
        )}
      </Show>
    </FieldV2>
  )
}
