import { Accordion } from "./accordion"
import { ParentProps } from "solid-js"

export function StickyAccordionHeader(props: ParentProps<{ class?: string }>) {
  return (
    <Accordion.Header data-component="sticky-accordion-header" class={props.class}>
      {props.children}
    </Accordion.Header>
  )
}
