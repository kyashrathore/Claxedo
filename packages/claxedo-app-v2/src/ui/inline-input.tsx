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
      data-component="v2-inline-input"
      data-disabled={local.disabled ? "" : undefined}
      data-invalid={local.invalid ? "" : undefined}
      data-numeric={local.numeric ? "" : undefined}
      data-appearance={local.appearance ?? "base"}
      data-label-width={local.labelWidth != null ? "" : undefined}
      classList={{
        "v2-inline-input": true,
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
        data-slot="v2-inline-input-prefix" class="v2-inline-input-prefix"
        onMouseDown={(event) => {
          if (local.disabled || event.button !== 0) return

          event.preventDefault()
          input?.focus()
        }}
      >
        <span data-slot="v2-inline-input-prefix-text" class="v2-inline-input-prefix-text">{local.prefix}</span>
      </div>
      <div data-slot="v2-inline-input-divider" aria-hidden="true" />
      <div data-slot="v2-inline-input-field" class="v2-inline-input-field">
        <div data-slot="v2-inline-input-value">
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
            data-slot="v2-inline-input-input" classList={{ "v2-inline-input-input": true }}
          />
        </div>
        <Show when={local.showCopyButton}>
          <button
            type="button"
            data-slot="v2-inline-input-icon-button" class="v2-inline-input-icon-button"
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
