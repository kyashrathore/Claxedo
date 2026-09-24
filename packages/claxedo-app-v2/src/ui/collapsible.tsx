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
      data-component="collapsible"
      data-variant={local.variant || "normal"}
      classList={{ "ui-collapsible": true, ...local.classList, [local.class ?? ""]: !!local.class }}
      {...others}
    />
  )
}

function CollapsibleTrigger(props: ComponentProps<typeof Kobalte.Trigger>) {
  return <Kobalte.Trigger data-slot="collapsible-trigger" {...props} classList={{ "ui-collapsible-trigger": true }} />
}

function CollapsibleContent(props: ComponentProps<typeof Kobalte.Content>) {
  return <Kobalte.Content {...({ staticPresence: true } as Record<string, unknown>)} data-slot="collapsible-content" {...props} />
}

function CollapsibleArrow(props: ComponentProps<"div">) {
  return (
    <div data-slot="collapsible-arrow" {...props} classList={{ "ui-collapsible-arrow": true }}>
      <span data-slot="collapsible-arrow-icon" class="ui-collapsible-arrow-icon">
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
