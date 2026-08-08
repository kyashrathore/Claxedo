import type { Component, JSX } from "solid-js"
import { createMemo, onMount, splitProps } from "solid-js"
import sprite from "./provider-icons/sprite.svg?raw"
import { iconNames, type IconName } from "./provider-icons/types"
import { createInlineSvgSprite } from "./inline-svg-sprite"

const providerIconSprite = createInlineSvgSprite("provider-icon-sprite", sprite)

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  const resolved = createMemo(() => (iconNames.includes(local.id as IconName) ? local.id : "synthetic"))
  onMount(() => providerIconSprite.ensure(resolved()))
  return (
    <svg
      data-component="provider-icon"
      {...rest}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <use href={providerIconSprite.href(resolved())} />
    </svg>
  )
}
