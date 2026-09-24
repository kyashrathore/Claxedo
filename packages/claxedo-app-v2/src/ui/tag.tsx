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
      data-component="v2-tag"
      data-variant={split.variant ?? "neutral"}
      classList={{
        "v2-tag": true,
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </span>
  )
}
