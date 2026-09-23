import { createEffect, createMemo, splitProps, type JSX } from "solid-js"
import { createLazySprite } from "./icon/sprite-host"
import names from "./provider-icon/names.json"
import spriteUrl from "./provider-icon/sprite.svg?url"
import "./provider-icon.css"

const known = new Set<string>(names)
const fallbackProvider = "synthetic"

export const providerIconNames: readonly string[] = names

export const providerIconSprite = createLazySprite("claxedo-provider-icon", async () => {
  const response = await fetch(spriteUrl)
  if (!response.ok) throw new Error(`The provider icon sprite failed to load (${response.status})`)
  return response.text()
})

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

export function ProviderIcon(props: ProviderIconProps) {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  const resolved = createMemo(() => (known.has(local.id) ? local.id : fallbackProvider))
  createEffect(() => providerIconSprite.ensure(resolved()))
  return (
    <svg
      data-component="provider-icon"
      data-provider={resolved()}
      {...rest}
      classList={{
        "ui-provider-icon": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <use href={providerIconSprite.href(resolved())} />
    </svg>
  )
}
