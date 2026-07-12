// target-layer: claxedo-ui/components - Claxedo-only v1 icon button wrapper.
import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, splitProps } from "solid-js"
import { ClaxedoIcon, type ClaxedoIconProps } from "@/ui/controls/claxedo-icon"

export interface ClaxedoIconButtonProps extends ComponentProps<typeof Kobalte> {
  icon: ClaxedoIconProps["name"]
  size?: "small" | "normal" | "large"
  iconSize?: ClaxedoIconProps["size"]
  variant?: "primary" | "secondary" | "ghost"
}

export function ClaxedoIconButton(props: ComponentProps<"button"> & ClaxedoIconButtonProps) {
  const [split, rest] = splitProps(props, ["variant", "size", "iconSize", "class", "classList"])
  return (
    <Kobalte
      {...rest}
      data-component="icon-button"
      data-icon={props.icon}
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <ClaxedoIcon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />
    </Kobalte>
  )
}
