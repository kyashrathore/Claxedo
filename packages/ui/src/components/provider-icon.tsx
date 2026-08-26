import type { Component } from "solid-js"
import type { JSX } from "@solidjs/web"
import { createEffect, createMemo, omit } from "solid-js"
import spriteURL from "./provider-icons/sprite.svg?url"
import { iconNames, type IconName } from "./provider-icons/types"
import { createLazyInlineSvgSprite } from "./inline-svg-sprite"

export const providerIconSprite = createLazyInlineSvgSprite("provider-icon-sprite", async () => {
  const response = await fetch(spriteURL)
  if (!response.ok) throw new Error(`Unable to load provider icon sprite (${response.status})`)
  return response.text()
})

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const local = props,
    rest = omit(props, "id", "class")
  const resolved = createMemo(() => (iconNames.includes(local.id as IconName) ? local.id : "synthetic"))
  createEffect(resolved, (id) => {
    providerIconSprite.ensure(id)
  })
  return (
    <svg data-component="provider-icon" {...rest} class={local.class}>
      <use href={providerIconSprite.href(resolved())} />
    </svg>
  )
}
