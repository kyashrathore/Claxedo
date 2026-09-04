import { Show } from "solid-js"
import type { PluginIcon } from "../api"

/**
 * A plugin's tile: the icon its manifest declares, else the monogram the
 * catalog derived from its name. The monogram uses theme surfaces rather than a
 * per-plugin brand color because the catalog carries no color and an invented
 * one would not survive a theme switch.
 */
export function PluginIconTile(props: { icon?: PluginIcon; name: string; size?: "card" | "pane" }) {
  const size = () => (props.size === "pane" ? "size-12 text-16-medium" : "size-10 text-14-medium")
  const url = () => {
    const icon = props.icon
    return icon && icon.kind === "url" ? icon.url : undefined
  }
  const monogram = () => {
    const icon = props.icon
    return icon && icon.kind === "monogram" ? icon.text : props.name.slice(0, 2).toUpperCase()
  }
  return (
    <span
      aria-hidden="true"
      data-component="agent-plugin-icon"
      class={`shrink-0 grid place-items-center rounded-lg overflow-hidden bg-surface-raised-stronger text-text-weak ${size()}`}
    >
      <Show when={url()} fallback={monogram()}>
        {(src) => <img src={src()} alt="" class="size-full object-cover" />}
      </Show>
    </span>
  )
}
