import { createEffect, createMemo, createUniqueId, Show, splitProps, type JSX } from "solid-js"
import { chooseFileIcon, type FileNode } from "./file-icon/choose"
import spriteUrl from "./file-icon/sprite.svg?url"
import { createLazySprite } from "./icon/sprite-host"
import "./file-icon.css"

export const fileIconSprite = createLazySprite("claxedo-file-icon", async () => {
  const response = await fetch(spriteUrl)
  if (!response.ok) throw new Error(`The file icon sprite failed to load (${response.status})`)
  return response.text()
})

export type FileIconProps = JSX.GSVGAttributes<SVGSVGElement> & {
  node: FileNode
  expanded?: boolean
  mono?: boolean
}

export function FileIcon(props: FileIconProps) {
  const [local, rest] = splitProps(props, ["node", "class", "classList", "expanded", "mono"])
  const name = createMemo(() => chooseFileIcon(local.node, local.expanded ?? false))
  const maskId = `claxedo-file-icon-mask-${createUniqueId()}`
  createEffect(() => fileIconSprite.ensure(name()))
  return (
    <svg
      data-component="file-icon"
      {...rest}
      classList={{
        "ui-file-icon": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Show when={local.mono} fallback={<use href={fileIconSprite.href(name())} />}>
        <defs>
          <mask id={maskId} mask-type="alpha">
            <use href={fileIconSprite.href(name())} />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="currentColor" mask={`url(#${maskId})`} />
      </Show>
    </svg>
  )
}

export { chooseFileIcon, type FileNode }
