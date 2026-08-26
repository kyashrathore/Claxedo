import { Button as Kobalte } from "@kobalte/core/button"
import { Show, omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import { Icon, IconProps } from "./icon"

export interface ButtonProps
  extends ComponentProps<typeof Kobalte>, Pick<ComponentProps<"button">, "class" | "children"> {
  size?: "small" | "normal" | "large"
  variant?: "primary" | "secondary" | "ghost"
  icon?: IconProps["name"]
}

export function Button(props: ButtonProps) {
  const split = props,
    rest = omit(props, "variant", "size", "icon", "class")
  return (
    <Kobalte
      {...rest}
      data-component="button"
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      data-icon={split.icon}
      class={["ui-button", split.class]}
    >
      <Show when={split.icon}>
        <Icon name={split.icon!} size="small" />
      </Show>
      {props.children}
    </Kobalte>
  )
}
