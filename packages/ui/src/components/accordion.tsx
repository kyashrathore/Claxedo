import { Accordion as Kobalte } from "@kobalte/core/accordion"
import { splitProps } from "solid-js"
import type { ComponentProps, ParentProps } from "solid-js"

export interface AccordionProps extends ComponentProps<typeof Kobalte> {}
export interface AccordionItemProps extends ComponentProps<typeof Kobalte.Item> {}
export interface AccordionHeaderProps extends ComponentProps<typeof Kobalte.Header> {}
export interface AccordionTriggerProps extends ComponentProps<typeof Kobalte.Trigger> {}
export interface AccordionContentProps extends ComponentProps<typeof Kobalte.Content> {}

function AccordionRoot(props: AccordionProps) {
  const [split, rest] = splitProps(props, ["class", "classList"])
  return (
    <Kobalte
      {...rest}
      data-component="accordion"
      classList={{
        "ui-accordion": true,
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    />
  )
}

function AccordionItem(props: AccordionItemProps) {
  const [split, rest] = splitProps(props, ["class", "classList"])
  return (
    <Kobalte.Item
      {...rest}
      data-slot="accordion-item"
      classList={{
        "ui-accordion-item": true,
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    />
  )
}

function AccordionHeader(props: ParentProps<AccordionHeaderProps>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Header
      {...rest}
      data-slot="accordion-header"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </Kobalte.Header>
  )
}

function AccordionTrigger(props: ParentProps<AccordionTriggerProps>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Trigger
      {...rest}
      data-slot="accordion-trigger"
      classList={{ "ui-accordion-trigger": true,
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </Kobalte.Trigger>
  )
}

function AccordionContent(props: ParentProps<AccordionContentProps>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Content
      {...rest}
      // `staticPresence` matches accordion.css: nothing there applies the
      // slideDown/slideUp keyframes to the content element, so Kobalte's
      // presence probe and content measurement have nothing to drive. Apply an
      // animation to [data-slot="accordion-content"] and this prop must go.
      staticPresence
      data-slot="accordion-content"
      classList={{ "ui-accordion-content": true,
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
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
