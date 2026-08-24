import type { ParentProps } from "solid-js"
import type { ComponentProps } from "@solidjs/web"

export interface KeybindProps extends ParentProps {
  class?: string
}

export function Keybind(props: KeybindProps) {
  return (
    <span data-component="keybind" class={props.class}>
      {props.children}
    </span>
  )
}
