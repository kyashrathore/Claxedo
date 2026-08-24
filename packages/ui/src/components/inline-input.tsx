import type { ComponentProps } from "@solidjs/web"
import { omit } from "solid-js"

export type InlineInputProps = ComponentProps<"input"> & {
  width?: string
}

export function InlineInput(props: InlineInputProps) {
  const local = props,
    others = omit(props, "class", "width", "style")

  const style = () => {
    if (!local.style) return { width: local.width }
    if (typeof local.style === "string") {
      if (!local.width) return local.style
      return `${local.style};width:${local.width}`
    }
    if (!local.width) return local.style
    return { ...local.style, width: local.width }
  }

  return <input data-component="inline-input" class={local.class} style={style()} {...others} />
}
