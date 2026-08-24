import { type Component } from "solid-js"
import type { JSX } from "@solidjs/web"

export const SettingsList: Component<{ children: JSX.Element }> = (props) => {
  return <div class="bg-surface-base px-4 rounded-lg">{props.children}</div>
}
