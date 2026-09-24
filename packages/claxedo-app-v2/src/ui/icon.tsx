import { onMount, splitProps, type ComponentProps } from "solid-js"
import { brandGlyphs } from "./icon/brand-glyphs"
import { navigationGlyphs } from "./icon/navigation-glyphs"
import { objectGlyphs } from "./icon/object-glyphs"
import { ensureSpriteHost } from "./icon/sprite-host"
import "./icon.css"

const glyphs = { ...brandGlyphs, ...navigationGlyphs, ...objectGlyphs }

export type IconName = keyof typeof glyphs
export type IconSize = "small" | "normal" | "medium" | "large"

export const iconNames = Object.freeze(Object.keys(glyphs) as IconName[])

export const isIconName = (value: string): value is IconName => value in glyphs

export interface IconProps extends ComponentProps<"svg"> {
  name: IconName
  size?: IconSize
}

const spriteId = "v2-icon-sprite"
const symbolId = (name: IconName) => `v2-icon-${name}`

function ensureSprite() {
  if (document.getElementById(spriteId)) return
  const host = ensureSpriteHost(spriteId)
  if (!host) return
  host.innerHTML = iconNames
    .map((name) => `<symbol id="${symbolId(name)}" viewBox="${glyphs[name].viewBox}">${glyphs[name].body}</symbol>`)
    .join("")
}

export function Icon(props: IconProps) {
  const [local, others] = splitProps(props, ["name", "size", "class", "classList"])
  onMount(ensureSprite)
  return (
    <svg
      data-component="v2-icon"
      data-slot="v2-icon-svg"
      data-icon={local.name}
      data-size={local.size || "normal"}
      classList={{
        "v2-icon": true,
        "v2-icon-svg": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      fill="none"
      viewBox={glyphs[local.name].viewBox}
      aria-hidden="true"
      {...others}
    >
      <use href={`#${symbolId(local.name)}`} />
    </svg>
  )
}
