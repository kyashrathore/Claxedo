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

const spriteId = "claxedo-icon-sprite"
const symbolId = (name: IconName) => `claxedo-icon-${name}`

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
      data-component="icon"
      data-slot="icon-svg"
      data-icon={local.name}
      data-size={local.size || "normal"}
      classList={{
        "ui-icon": true,
        "ui-icon-svg": true,
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
