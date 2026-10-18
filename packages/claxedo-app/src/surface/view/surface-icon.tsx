import { Show, type JSX } from "solid-js"
import { Icon } from "@/ui"
import { surfaceIconSource, type SurfaceIconName } from "../icon-names"
import { SURFACE_GLYPHS } from "./surface-glyphs"

export type SurfaceIconSize = "small" | "normal"

export function SurfaceIcon(props: { readonly name: SurfaceIconName; readonly size: SurfaceIconSize }) {
  const source = () => surfaceIconSource(props.name)
  const kitName = () => {
    const current = source()
    return current.kind === "kit" ? current.name : undefined
  }
  const glyph = () => {
    const current = source()
    return current.kind === "glyph" ? SURFACE_GLYPHS[current.name] : undefined
  }
  return (
    <Show when={kitName()} fallback={<Show when={glyph()}>{(draw) => <SurfaceGlyph draw={draw()} size={props.size} />}</Show>}>
      {(name) => <Icon name={name()} size={props.size} />}
    </Show>
  )
}

function SurfaceGlyph(props: { readonly draw: () => JSX.Element; readonly size: SurfaceIconSize }) {
  return (
    <svg class="ui-icon ui-icon-svg" data-size={props.size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        {props.draw()}
      </g>
    </svg>
  )
}
