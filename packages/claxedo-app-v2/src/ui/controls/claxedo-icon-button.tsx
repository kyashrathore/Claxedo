// Claxedo-only v1 icon button wrapper.
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
      // An icon button that says nothing about its state is a control that is
      // always on screen, so it starts at full strength rather than dim. This
      // also lets a filled `primary` button keep its own inverse foreground —
      // the `[data-variant="primary"][data-icon-interaction="persistent"]` rule
      // in `app/styles/ui-overrides.css` only reaches the persistent default,
      // and without it the send arrow paints the same colour as its circle.
      data-icon-interaction={props["data-icon-interaction"] ?? "persistent"}
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      classList={{ "ui-icon-button": true,
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <ClaxedoIcon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />
    </Kobalte>
  )
}
