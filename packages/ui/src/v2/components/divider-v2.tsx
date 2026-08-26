import { omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import "./divider-v2.css"

export interface DividerV2Props extends ComponentProps<"div"> {}

export function DividerV2(props: DividerV2Props) {
  const local = props,
    rest = omit(props, "class")
  return (
    <div {...rest} role="separator" aria-orientation="horizontal" data-component="divider-v2" class={local.class} />
  )
}
