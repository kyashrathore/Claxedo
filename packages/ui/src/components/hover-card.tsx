import { HoverCard as Kobalte } from "@kobalte/core/hover-card"
import { Element, ParentProps, omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"

export interface HoverCardProps extends ParentProps, Omit<ComponentProps<typeof Kobalte>, "children"> {
  trigger: Element
  mount?: HTMLElement
  class?: ComponentProps<"div">["class"]
}

export function HoverCard(props: HoverCardProps) {
  const local = props,
    rest = omit(props, "trigger", "mount", "class", "children")

  return (
    <Kobalte gutter={4} {...rest}>
      <Kobalte.Trigger as="div" data-slot="hover-card-trigger" tabindex={-1}>
        {local.trigger}
      </Kobalte.Trigger>
      <Kobalte.Portal mount={local.mount}>
        <Kobalte.Content data-component="hover-card-content" class={local.class}>
          <div data-slot="hover-card-body">{local.children}</div>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
