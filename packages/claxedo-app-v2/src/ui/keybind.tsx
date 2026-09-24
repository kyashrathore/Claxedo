import { type ComponentProps, For, splitProps } from "solid-js"
import "./keybind.css"

export interface KeybindProps extends ComponentProps<"div"> {
  keys: string[]
  variant?: "neutral" | "ghost"
}

export function Keybind(props: KeybindProps) {
  const [local, rest] = splitProps(props, ["keys", "variant", "class", "classList"])
  return (
    <div
      {...rest}
      data-component="v2-keybind"
      data-variant={local.variant || "neutral"}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <For each={local.keys}>
        {(key) => (
          <div data-slot="v2-keybind-key" class="v2-keybind-key">
            <span data-slot="v2-keybind-label" class="v2-keybind-label">{key}</span>
          </div>
        )}
      </For>
    </div>
  )
}
