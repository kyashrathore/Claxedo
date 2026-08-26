import { Button as Kobalte } from "@kobalte/core/button"
import { omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import type { JSX } from "@solidjs/web"
import "./icon-button-v2.css"

export interface IconButtonV2Props extends ComponentProps<typeof Kobalte>, Pick<ComponentProps<"button">, "class"> {
  // temporary
  icon?: JSX.Element
  // icon: IconProps["name"]
  size?: "small" | "normal" | "large"
  // iconSize?: IconProps["size"]
  variant?: "neutral" | "contrast" | "ghost" | "ghost-muted"
  state?: "rest" | "hover" | "pressed"
}

export function IconButtonV2(props: ComponentProps<"button"> & IconButtonV2Props) {
  const split = props,
    rest = omit(props, "variant", "size", "iconSize", "class", "state")
  return (
    <Kobalte
      {...rest}
      data-component="icon-button-v2"
      // data-icon={props.icon}
      data-size={split.size || "normal"}
      data-variant={split.variant || "neutral"}
      data-state={split.state}
      class={split.class}
    >
      {props.icon}
      {/*<Icon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />*/}
    </Kobalte>
  )
}
