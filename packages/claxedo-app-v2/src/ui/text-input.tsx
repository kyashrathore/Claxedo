import { type ComponentProps, type JSX, Show, splitProps } from "solid-js"
import { Icon } from "./icon"
import "./text-input.css"

export interface TextInputProps extends Omit<ComponentProps<"input">, "type"> {

  leadingIcon?: JSX.Element

  showCopyButton?: boolean

  showClearButton?: boolean

  copyLabel?: string

  clearLabel?: string
  onCopyClick?: (event: MouseEvent) => void
  onClearClick?: (event: MouseEvent) => void

  numeric?: boolean

  invalid?: boolean

  appearance?: "base" | "large"
  type?: ComponentProps<"input">["type"]
}

export function TextInput(props: TextInputProps) {
  const [local, inputProps] = splitProps(props, [
    "class",
    "classList",
    "leadingIcon",
    "showCopyButton",
    "showClearButton",
    "copyLabel",
    "clearLabel",
    "onCopyClick",
    "onClearClick",
    "numeric",
    "invalid",
    "appearance",
    "disabled",
  ])

  return (
    <div
      data-component="v2-text-input"
      data-disabled={local.disabled ? "" : undefined}
      data-invalid={local.invalid ? "" : undefined}
      data-numeric={local.numeric ? "" : undefined}
      data-appearance={local.appearance ?? "base"}
      data-leading-icon={local.leadingIcon ? "" : undefined}
      classList={{
        "v2-text-input": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <div data-slot="v2-text-input-value">
        <Show when={local.leadingIcon}>
          <span data-slot="v2-text-input-leading-icon">{local.leadingIcon}</span>
        </Show>
        <input
          {...inputProps}
          type={inputProps.type ?? "text"}
          disabled={local.disabled}
          aria-invalid={local.invalid ? true : undefined}
          data-slot="v2-text-input-input" classList={{ "v2-text-input-input": true }}
        />
      </div>
      <Show when={local.showClearButton || local.showCopyButton}>
        <button
          type="button"
          data-slot="v2-text-input-icon-button" class="v2-text-input-icon-button"
          data-variant={local.showClearButton ? "clear" : "copy"}
          aria-label={local.showClearButton ? (local.clearLabel ?? "Clear") : (local.copyLabel ?? "Copy")}
          disabled={local.disabled}
          onMouseDown={(event) => {
            if (!local.showClearButton) return
            event.preventDefault()
          }}
          onClick={(event) => {
            if (local.showClearButton) {
              local.onClearClick?.(event)
              return
            }
            local.onCopyClick?.(event)
          }}
        >
          <Icon name={local.showClearButton ? "xmark-small" : "copy"} />
        </button>
      </Show>
    </div>
  )
}
