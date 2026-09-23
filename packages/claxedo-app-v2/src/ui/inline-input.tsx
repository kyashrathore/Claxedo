import { type ComponentProps, type JSX, Show, splitProps } from "solid-js"
import { Icon } from "./icon"
import "./inline-input.css"

export interface InlineInputProps extends Omit<ComponentProps<"input">, "type" | "prefix"> {

  prefix: JSX.Element

  labelWidth?: number | string

  showCopyButton?: boolean

  copyLabel?: string
  onCopyClick?: (event: MouseEvent) => void

  numeric?: boolean

  invalid?: boolean

  appearance?: "base" | "large"
  type?: ComponentProps<"input">["type"]
}

export function InlineInput(props: InlineInputProps) {
  const [local, inputProps] = splitProps(props, [
    "class",
    "classList",
    "prefix",
    "labelWidth",
    "showCopyButton",
    "copyLabel",
    "onCopyClick",
    "numeric",
    "invalid",
    "appearance",
    "disabled",
    "style",
  ])

  let input: HTMLInputElement | undefined

  return (
    <div
      data-component="inline-input"
      data-disabled={local.disabled ? "" : undefined}
      data-invalid={local.invalid ? "" : undefined}
      data-numeric={local.numeric ? "" : undefined}
      data-appearance={local.appearance ?? "base"}
      data-label-width={local.labelWidth != null ? "" : undefined}
      classList={{
        "ui-inline-input": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      style={{
        ...(typeof local.style === "object" && local.style != null ? local.style : {}),
        ...(local.labelWidth != null
          ? {
              "--inline-input-label-width":
                typeof local.labelWidth === "number" ? `${local.labelWidth}px` : local.labelWidth,
            }
          : {}),
      }}
    >
      <div
        data-slot="inline-input-prefix" class="ui-inline-input-prefix"
        onMouseDown={(event) => {
          if (local.disabled || event.button !== 0) return

          event.preventDefault()
          input?.focus()
        }}
      >
        <span data-slot="inline-input-prefix-text" class="ui-inline-input-prefix-text">{local.prefix}</span>
      </div>
      <div data-slot="inline-input-divider" aria-hidden="true" />
      <div data-slot="inline-input-field" class="ui-inline-input-field">
        <div data-slot="inline-input-value">
          <input
            {...inputProps}
            ref={(el) => {
              input = el
              const ref = inputProps.ref
              if (typeof ref === "function") ref(el)
            }}
            type={inputProps.type ?? "text"}
            disabled={local.disabled}
            aria-invalid={local.invalid ? true : undefined}
            data-slot="inline-input-input" classList={{ "ui-inline-input-input": true }}
          />
        </div>
        <Show when={local.showCopyButton}>
          <button
            type="button"
            data-slot="inline-input-icon-button" class="ui-inline-input-icon-button"
            aria-label={local.copyLabel ?? "Copy"}
            disabled={local.disabled}
            onClick={local.onCopyClick}
          >
            <Icon name="copy" />
          </button>
        </Show>
      </div>
    </div>
  )
}
