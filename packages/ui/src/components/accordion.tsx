import { Accordion as Kobalte } from "@kobalte/core/accordion"
import { omit } from "solid-js"
import type { ParentProps } from "solid-js"
import type { ComponentProps } from "@solidjs/web"

export interface AccordionProps extends ComponentProps<typeof Kobalte> {}
export interface AccordionItemProps extends ComponentProps<typeof Kobalte.Item> {}
export interface AccordionHeaderProps extends ComponentProps<typeof Kobalte.Header> {}
export interface AccordionTriggerProps extends ComponentProps<typeof Kobalte.Trigger> {}
export interface AccordionContentProps extends ComponentProps<typeof Kobalte.Content> {}

function AccordionRoot(props: AccordionProps) {
  const split = props,
    rest = omit(props, "class")
  return <Kobalte {...rest} data-component="accordion" class={split.class} />
}

function AccordionItem(props: AccordionItemProps) {
  const split = props,
    rest = omit(props, "class")
  return <Kobalte.Item {...rest} data-slot="accordion-item" class={split.class} />
}

function AccordionHeader(props: ParentProps<AccordionHeaderProps>) {
  const split = props,
    rest = omit(props, "class", "children")
  return (
    <Kobalte.Header {...rest} data-slot="accordion-header" class={split.class}>
      {split.children}
    </Kobalte.Header>
  )
}

function AccordionTrigger(props: ParentProps<AccordionTriggerProps>) {
  const split = props,
    rest = omit(props, "class", "children")
  return (
    <Kobalte.Trigger {...rest} data-slot="accordion-trigger" class={split.class}>
      {split.children}
    </Kobalte.Trigger>
  )
}

function AccordionContent(props: ParentProps<AccordionContentProps>) {
  const split = props,
    rest = omit(props, "class", "children")
  return (
    <Kobalte.Content {...rest} data-slot="accordion-content" class={split.class}>
      {split.children}
    </Kobalte.Content>
  )
}

export const Accordion = Object.assign(AccordionRoot, {
  Item: AccordionItem,
  Header: AccordionHeader,
  Trigger: AccordionTrigger,
  Content: AccordionContent,
})
