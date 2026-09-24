import { type ComponentProps, splitProps } from "solid-js"
import "./tag.css"

export interface TagProps extends ComponentProps<"span"> {
  variant?: "neutral" | "accent"
}

export function Tag(props: TagProps) {
  const [split, rest] = splitProps(props, ["class", "classList", "children", "variant"])
  return (
    <span
      {...rest}
      data-component="tag"
      data-variant={split.variant ?? "neutral"}
      classList={{
        "ui-tag": true,
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </span>
  )
}
