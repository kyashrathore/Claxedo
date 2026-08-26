import { omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import { usePlatform } from "@/platform/runtime/platform-provider"

export interface LinkProps extends Omit<ComponentProps<"a">, "href"> {
  href: string
}

export function Link(props: LinkProps) {
  const platform = usePlatform()
  const local = props,
    rest = omit(props, "href", "children", "class")

  return (
    <a
      href={local.href}
      class={`text-text-strong underline ${local.class ?? ""}`}
      onClick={(event) => {
        if (!local.href) return
        event.preventDefault()
        platform.openLink(local.href)
      }}
      {...rest}
    >
      {local.children}
    </a>
  )
}
