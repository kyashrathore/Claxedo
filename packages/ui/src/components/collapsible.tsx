import { Collapsible as Kobalte, CollapsibleRootProps } from "@kobalte/core/collapsible"
import { ParentProps, omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import { Icon } from "./icon"

export interface CollapsibleProps extends ParentProps<CollapsibleRootProps> {
  class?: string

  variant?: "normal" | "ghost"
}

function CollapsibleRoot(props: CollapsibleProps) {
  const local = props,
    others = omit(props, "class", "variant")
  return (
    <Kobalte
      data-component="collapsible"
      data-variant={local.variant || "normal"}
      class={["ui-collapsible", local.class]}
      {...others}
    />
  )
}

function CollapsibleTrigger(props: ComponentProps<typeof Kobalte.Trigger>) {
  return <Kobalte.Trigger data-slot="collapsible-trigger" {...props} class={["ui-collapsible-trigger", props.class]} />
}

function CollapsibleContent(props: ComponentProps<typeof Kobalte.Content>) {
  // NOTE (perf, carried over from the Solid 1 line): collapsible.css keeps the
  // slideDown/slideUp keyframes commented out, so nothing animates this
  // element and Kobalte's presence probe and content measurement have nothing
  // to drive. That was skipped via a `staticPresence` prop added by
  // patches/@kobalte%2Fcore@0.13.12.patch. @kobalte/core 2.0.0-alpha.0 does not
  // accept that prop and the 0.13.12 patch no longer applies, so the probe is
  // back until the patch is re-ported against the 2.x content implementation.
  return <Kobalte.Content data-slot="collapsible-content" {...props} />
}

function CollapsibleArrow(props?: ComponentProps<"div">) {
  return (
    <div data-slot="collapsible-arrow" {...(props || {})} class={["ui-collapsible-arrow", props?.class]}>
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
