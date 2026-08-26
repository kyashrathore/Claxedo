import { omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import "./badge-v2.css"

export interface TagProps extends ComponentProps<"span"> {
  variant?: "neutral" | "accent"
}

export function Tag(props: TagProps) {
  const split = props,
    rest = omit(props, "class", "children", "variant")
  return (
    <span {...rest} data-component="tag" data-variant={split.variant ?? "neutral"} class={split.class}>
      {split.children}
    </span>
  )
}
