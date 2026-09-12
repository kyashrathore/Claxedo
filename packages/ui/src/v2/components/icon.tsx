import { OPEN_CODE_V2_ARTWORK } from "../../components/opencode-v2-artwork"
import { onMount, type ComponentProps, splitProps } from "solid-js"
import { ensureSvgSpriteHost } from "../../components/inline-svg-sprite"
import { isKeyOf } from "../../utils/record"

const icons = OPEN_CODE_V2_ARTWORK

const spriteID = "opencode-v2-icon-sprite"
export const openCodeV2IconNames = Object.freeze(
  Object.keys(icons).filter((name): name is keyof typeof icons => isKeyOf(icons, name)),
)
export function getOpenCodeV2IconArtwork(name: keyof typeof icons) {
  return { id: `opencode-v2-icon-${name}`, name, viewBox: icons[name].viewBox, content: icons[name].body }
}
const symbol = (name: keyof typeof icons) => `opencode-v2-icon-${name}`
let spriteInserted = false

function ensureSprite() {
  if (spriteInserted) return
  const host = ensureSvgSpriteHost(spriteID)
  if (!host) return
  if (host.childElementCount === 0) {
    host.innerHTML = Object.keys(icons)
      .map((name) => {
        // `Object.keys` widens to `string`; every key here is by construction a real name.
        if (!isKeyOf(icons, name)) return ""
        const icon = icons[name]
        return `<symbol id="${symbol(name)}" viewBox="${icon.viewBox}">${icon.body}</symbol>`
      })
      .join("")
  }
  spriteInserted = true
}


export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons | (string & {})
  size?: "small" | "normal" | "large"
}

export function Icon(props: IconProps) {
  const [split, rest] = splitProps(props, ["name", "size"])
  const iconName = () => (isKeyOf(icons, split.name) ? split.name : "plus")
  const icon = () => icons[iconName()]
  const pixelSize = split.size === "small" ? 14 : split.size === "large" ? 20 : 16
  onMount(ensureSprite)

  return (
    <svg
      {...rest}
      data-slot="icon-svg"
      classList={{ "ui-icon-svg": true }}
      width={pixelSize}
      height={pixelSize}
      viewBox={icon().viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <use href={`#${symbol(iconName())}`} />
    </svg>
  )
}
