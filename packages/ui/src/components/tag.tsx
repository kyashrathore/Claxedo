import { omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"

export interface TagProps extends ComponentProps<"span"> {
  size?: "normal" | "large"
}

export function Tag(props: TagProps) {
  const split = props,
    rest = omit(props, "size", "class", "children")
  return (
    <span {...rest} data-component="tag" data-size={split.size || "normal"} class={split.class}>
      {split.children}
    </span>
  )
}
