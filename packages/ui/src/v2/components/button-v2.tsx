import { Button as Kobalte } from "@kobalte/core/button"
import { Show, createMemo, omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import { Icon, type IconProps } from "./icon"
import "./button-v2.css"

export interface ButtonV2Props
  extends ComponentProps<typeof Kobalte>, Pick<ComponentProps<"button">, "class" | "children"> {
  size?: "small" | "normal" | "large"
  variant?: "neutral" | "danger" | "warning" | "outline" | "contrast" | "ghost" | "ghost-muted" | "loading"
  icon?: IconProps["name"]
}

export function ButtonV2(props: ButtonV2Props) {
  const split = props,
    rest = omit(props, "variant", "size", "icon", "class")
  const resolvedIcon = createMemo(() => split.icon)
  return (
    <Kobalte
      {...rest}
      data-component="button-v2"
      data-size={split.size || "normal"}
      data-variant={split.variant || "neutral"}
      data-icon={resolvedIcon()}
      class={split.class}
    >
      <Show when={resolvedIcon()}>
        <Icon name={resolvedIcon()!} />
      </Show>
      {props.children}
    </Kobalte>
  )
}
