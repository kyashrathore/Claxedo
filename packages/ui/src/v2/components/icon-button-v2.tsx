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
      /* The stylesheet keys off `.ui-icon-button-v2` (a class bucket, not the
         `[data-component]` attribute selector) — Solid 2 has no `classList`,
         so the static class and the consumer's land in one class string. */
      class={`ui-icon-button-v2 ${split.class ?? ""}`}
    >
      {props.icon}
      {/*<Icon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />*/}
    </Kobalte>
  )
}
