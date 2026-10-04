import { Accordion } from "./accordion"
import { ParentProps } from "solid-js"

export function StickyAccordionHeader(
  props: ParentProps<{ class?: string; classList?: Record<string, boolean | undefined> }>,
) {
  return (
    <Accordion.Header
      data-component="sticky-accordion-header"
      classList={{
        "ui-sticky-accordion-header": true,
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
    >
      {props.children}
    </Accordion.Header>
  )
}
