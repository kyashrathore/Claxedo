import { Collapsible as Kobalte, type CollapsibleRootProps } from "@kobalte/core/collapsible"
import { splitProps, type ComponentProps, type ParentProps } from "solid-js"
import { Icon } from "./icon"
import "./collapsible.css"

export interface CollapsibleProps extends ParentProps<CollapsibleRootProps> {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  variant?: "normal" | "ghost"
}

function CollapsibleRoot(props: CollapsibleProps) {
  const [local, others] = splitProps(props, ["class", "classList", "variant"])
  return (
    <Kobalte
      data-component="v2-collapsible"
      data-variant={local.variant || "normal"}
      classList={{ "v2-collapsible": true, ...local.classList, [local.class ?? ""]: !!local.class }}
      {...others}
    />
  )
}

function CollapsibleTrigger(props: ComponentProps<typeof Kobalte.Trigger>) {
  return <Kobalte.Trigger data-slot="v2-collapsible-trigger" {...props} classList={{ "v2-collapsible-trigger": true }} />
}

function CollapsibleContent(props: ComponentProps<typeof Kobalte.Content>) {
  return <Kobalte.Content {...({ staticPresence: true } as Record<string, unknown>)} data-slot="v2-collapsible-content" {...props} />
}

function CollapsibleArrow(props: ComponentProps<"div">) {
  return (
    <div data-slot="v2-collapsible-arrow" {...props} classList={{ "v2-collapsible-arrow": true }}>
      <span data-slot="v2-collapsible-arrow-icon" class="v2-collapsible-arrow-icon">
        <Icon name="chevron-down" size="small" />
      </span>
    </div>
  )
}

export const Collapsible = Object.assign(CollapsibleRoot, {
  Arrow: CollapsibleArrow,
  Trigger: CollapsibleTrigger,
  Content: CollapsibleContent,
})
