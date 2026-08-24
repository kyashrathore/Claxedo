import { Button as Kobalte } from "@kobalte/core/button"
import { omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import { Icon, IconProps } from "./icon"

export interface IconButtonProps extends ComponentProps<typeof Kobalte> {
  icon: IconProps["name"]
  size?: "small" | "normal" | "large"
  iconSize?: IconProps["size"]
  variant?: "primary" | "secondary" | "ghost"
}

export function IconButton(props: ComponentProps<"button"> & IconButtonProps) {
  const split = props,
    rest = omit(props, "variant", "size", "iconSize", "class")
  return (
    <Kobalte
      {...rest}
      data-component="icon-button"
      data-icon={props.icon}
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      class={split.class}
    >
      <Icon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />
    </Kobalte>
  )
}
