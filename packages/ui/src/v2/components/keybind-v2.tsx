import { For, omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import "./keybind-v2.css"

export interface KeybindV2Props extends ComponentProps<"div"> {
  keys: string[]
  variant?: "neutral" | "ghost"
}

export function KeybindV2(props: KeybindV2Props) {
  const local = props,
    rest = omit(props, "keys", "variant", "class")
  return (
    <div {...rest} data-component="keybind-v2" data-variant={local.variant || "neutral"} class={local.class}>
      <For each={local.keys}>
        {(key) => (
          <div data-slot="keybind-v2-key">
            <span data-slot="keybind-v2-label">{key}</span>
          </div>
        )}
      </For>
    </div>
  )
}
