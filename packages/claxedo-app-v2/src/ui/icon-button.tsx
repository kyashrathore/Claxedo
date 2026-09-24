import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, splitProps } from "solid-js"
import { Icon, type IconName, type IconSize } from "./icon"
import "./icon-button.css"

export interface IconButtonProps
  extends ComponentProps<typeof Kobalte>,
    Pick<ComponentProps<"button">, "class" | "classList"> {
  icon: IconName
  iconSize?: IconSize
  size?: "small" | "normal" | "large"
  variant?: "neutral" | "contrast" | "ghost" | "ghost-muted"
  state?: "rest" | "hover" | "pressed"
}

const iconSizeFor = (size: IconButtonProps["size"]): IconSize => {
  if (size === "small") return "small"
  if (size === "large") return "medium"
  return "normal"
}

export function IconButton(props: IconButtonProps) {
  const [split, rest] = splitProps(props, ["icon", "iconSize", "variant", "size", "class", "classList", "state"])
  return (
    <Kobalte
      {...rest}
      data-component="icon-button"
      data-icon={split.icon}
      data-size={split.size || "normal"}
      data-variant={split.variant || "neutral"}
      data-state={split.state}
      classList={{
        "ui-icon-button": true,
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Icon name={split.icon} size={split.iconSize ?? iconSizeFor(split.size)} />
    </Kobalte>
  )
}
